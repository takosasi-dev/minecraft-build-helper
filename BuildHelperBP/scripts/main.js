/**
 * マルチプレイ建築支援アドオン — 実装本体
 *
 * 使用API: @minecraft/server 2.0.0 / @minecraft/server-ui 2.0.0（いずれも安定版のみ）
 * ベータAPI（x.y.z-beta）は一切使用していない。
 *
 * 実装している機能（仕様書 第3章）:
 *   FR-1 設計図保存      … StructureManager.createFromWorld で最大 64x64x64 まで保存
 *   FR-2 ゴースト表示    … 未設置ブロックをパーティクルで可視化（10tick間隔・予算制）
 *   FR-3 進捗チェック    … 設置済み/総数/完成率
 *   FR-4 資材配分リスト  … 不足数からメンバー所持数を引き、残りを均等割り
 *   FR-5 ミラー設置      … 基準面に対して対称位置へ設置（インベントリから実消費）
 *   FR-6 ガイドライン    … 直線／グリッドを一時表示し、指定秒数で自動消去
 *   FR-7 集合テレポート  … 他プレイヤー全員を実行者の現在地へ（60秒クールダウン）
 *
 * 禁止事項（仕様書 第11章）の遵守:
 *   - fill/clone コマンドや StructureManager.place による無償ブロック生成は行わない。
 *     ブロックを置くのはミラー設置だけで、必ずインベントリから1個消費する。
 *   - 保護・権限・アクセス制御に類する機能は持たない。
 *   - UI表記はすべて日本語。
 *   - 毎tickの全ブロック走査は行わない（描画は10tick間隔＋1パスあたりの予算上限）。
 *   - 設計図のブロックデータは Dynamic Property に入れない（StructureManager のみ）。
 */

import {
  world,
  system,
  GameMode,
  BlockPermutation,
  StructureSaveMode,
  EquipmentSlot,
  ItemStack,
} from "@minecraft/server";
import { ActionFormData, ModalFormData, FormCancelationReason } from "@minecraft/server-ui";
import { blockNameJa } from "./block_names.js";
import { BOOK_SECTIONS, patchNotesBody, creditsBody } from "./book.js";

const NS = "buildhelper";
const TPS = 20;

// ---- 制限値・チューニング定数 -------------------------------------------------

/** 設計図として保存できる1辺の最大長（仕様書 FR-1）。 */
const MAX_SIDE = 64;
/** 設計図名の文字数制限（仕様書 第6章）。 */
const NAME_MIN = 1;
const NAME_MAX = 30;

/** ゴースト表示・ガイドライン表示の再描画間隔（tick）。仕様書の「10tick間隔以上」。 */
const RENDER_INTERVAL = 10;
/** ゴースト表示1パスあたりに判定するブロック数の上限。 */
const GHOST_BUDGET = 3000;
/** ゴースト表示1パスあたりに出すパーティクル数の上限。 */
const GHOST_PARTICLE_LIMIT = 160;
/** ゴースト表示の描画半径（これより遠いブロックは判定も描画もしない）。 */
const GHOST_RADIUS = 20;

/** ガイドラインの片側の伸長（ブロック）。 */
const GUIDE_EXTENT = 32;
/** ガイドライン1パスあたりのパーティクル数の上限。 */
const GUIDE_PARTICLE_LIMIT = 320;

/** runJob 内で1tickあたりに処理する件数。 */
const JOB_CHUNK = 2048;

/** 持ち寄りリストに載せるブロック種類の上限（フォーム本文が長くなりすぎるため）。 */
const SHARE_LIST_LIMIT = 20;

/** 集合テレポートのクールダウン（仕様書 FR-7）。 */
const RALLY_COOLDOWN_TICKS = 60 * TPS;

const PARTICLE_MISSING = "minecraft:villager_happy";
const PARTICLE_GUIDE = "minecraft:endrod";
const PARTICLE_MARK = "minecraft:basic_crit_particle";

// ---- Dynamic Property キー（仕様書 第5章） -----------------------------------

const DP_LIST = `${NS}:blueprint_list`;
const DP_GHOST = `${NS}:ghost_state`;
const DP_MIRROR = `${NS}:mirror_axis`;
const DP_RALLY_CD = `${NS}:teleport_cooldown`;
// 始点・終点は「アイテム操作で一時保存しておく座標」（仕様書 第6章）。
const DP_POS1 = `${NS}:sel_pos1`;
const DP_POS2 = `${NS}:sel_pos2`;
// ガイドブックを配ったかどうか（初回ログイン時の1回だけ配るため）。
const DP_BOOK_GIVEN = `${NS}:book_given`;

/** 初回ログインからガイドブックを渡すまでの待ち時間。ワールド読み込みの完了を待つ。 */
const BOOK_GIVE_DELAY = 20;

// ---- メモリ上の状態（永続化しないもの） --------------------------------------

/** blueprintId → [{ i: 局所座標のパック値, perm: BlockPermutation }]（空気を除く） */
const cellCache = new Map();
/** blueprintId → true（セル一覧を構築中） */
const cellBuilding = new Set();
/** playerId → ゴースト描画のカーソル位置 */
const ghostCursor = new Map();
/** playerId → { mode, axis, origin, expiresAt } */
const guides = new Map();
/** playerId → true（ミラー設置の在庫不足を通知済み。仕様書の「1回だけ通知する」） */
const mirrorWarned = new Set();

// =============================================================================
// 汎用ヘルパー
// =============================================================================

function warn(where, err) {
  console.warn(`[${NS}] ${where}: ${err}`);
}

/** 例外でゲーム側を巻き込まないためのラッパー。 */
function safe(where, fn) {
  try {
    return fn();
  } catch (err) {
    warn(where, err);
    return undefined;
  }
}

function isCreative(player) {
  try {
    return player.getGameMode() === GameMode.Creative;
  } catch {
    /* 古い実装向けのフォールバック */
  }
  try {
    return world.getPlayers({ gameMode: GameMode.Creative }).some((p) => p.id === player.id);
  } catch {
    return false;
  }
}

function floorVec(v) {
  return { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) };
}

function vecText(v) {
  return `${v.x}, ${v.y}, ${v.z}`;
}

function readJson(holder, key) {
  const raw = holder.getDynamicProperty(key);
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    warn(`readJson(${key})`, err);
    return undefined;
  }
}

function writeJson(holder, key, value) {
  if (value === undefined) holder.setDynamicProperty(key, undefined);
  else holder.setDynamicProperty(key, JSON.stringify(value));
}

/**
 * フォームを表示する。プレイヤーが他のUIを開いている（UserBusy）場合は
 * 少し待って再試行する。統合版ではアイテム使用直後に UserBusy になることがある。
 */
function showForm(form, player, attempt = 0) {
  return form.show(player).then((res) => {
    if (res.canceled && res.cancelationReason === FormCancelationReason.UserBusy && attempt < 20) {
      return new Promise((resolve) => {
        system.runTimeout(() => resolve(showForm(form, player, attempt + 1)), 10);
      });
    }
    return res;
  });
}

function dimensionNameJa(id) {
  if (id === "minecraft:overworld") return "オーバーワールド";
  if (id === "minecraft:nether") return "ネザー";
  if (id === "minecraft:the_end") return "ジ・エンド";
  return id;
}

function formatDate(ms) {
  try {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return "不明";
  }
}

// =============================================================================
// 設計図メタデータ（world Dynamic Property）
// =============================================================================

function loadBlueprints() {
  const list = readJson(world, DP_LIST);
  return Array.isArray(list) ? list : [];
}

function saveBlueprints(list) {
  writeJson(world, DP_LIST, list);
}

/** 名前から決まる安定したハッシュ。同じ名前なら常に同じ id になる。 */
function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * 設計図の識別子を作る。日本語名でもそのままでは Structure の識別子に使えないため、
 * 名前のハッシュから `buildhelper:bp_xxxxxxxx` を組み立てる。
 * 万一別名でハッシュが衝突したときだけ連番を足す。
 */
function makeBlueprintId(name, list) {
  const base = `${NS}:bp_${hashString(name)}`;
  const taken = new Set(list.map((b) => b.id));
  if (!taken.has(base)) return base;
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now().toString(36)}`;
}

function findBlueprint(id) {
  return loadBlueprints().find((b) => b.id === id);
}

/** 設計図の実体（Structure）を取り出す。失われていれば undefined。 */
function getStructure(id) {
  try {
    return world.structureManager.get(id);
  } catch (err) {
    warn("getStructure", err);
    return undefined;
  }
}

// =============================================================================
// 選択範囲（始点・終点）
// =============================================================================

function getSelection(player) {
  return {
    pos1: readJson(player, DP_POS1),
    pos2: readJson(player, DP_POS2),
  };
}

function setSelectionPoint(player, which, block) {
  const point = { ...floorVec(block.location), dim: block.dimension.id };
  writeJson(player, which === 1 ? DP_POS1 : DP_POS2, point);

  const label = which === 1 ? "始点" : "終点";
  player.onScreenDisplay.setActionBar(`§a${label}を設定: ${vecText(point)}`);
  try {
    block.dimension.spawnParticle(PARTICLE_MARK, {
      x: point.x + 0.5,
      y: point.y + 1.1,
      z: point.z + 0.5,
    });
  } catch {
    /* 目印の粒が出せなくても選択自体は成立するので黙って続ける */
  }

  const sel = getSelection(player);
  if (sel.pos1 && sel.pos2) {
    const range = selectionRange(sel);
    if (range) {
      player.sendMessage(
        `§7選択範囲: ${range.size.x} x ${range.size.y} x ${range.size.z} （${range.volume} ブロック）`
      );
    }
  }
}

/** 始点・終点から最小座標・サイズを求める。ディメンションが違えば undefined。 */
function selectionRange(sel) {
  if (!sel.pos1 || !sel.pos2) return undefined;
  if (sel.pos1.dim !== sel.pos2.dim) return undefined;
  const min = {
    x: Math.min(sel.pos1.x, sel.pos2.x),
    y: Math.min(sel.pos1.y, sel.pos2.y),
    z: Math.min(sel.pos1.z, sel.pos2.z),
  };
  const max = {
    x: Math.max(sel.pos1.x, sel.pos2.x),
    y: Math.max(sel.pos1.y, sel.pos2.y),
    z: Math.max(sel.pos1.z, sel.pos2.z),
  };
  const size = { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };
  return { min, max, size, volume: size.x * size.y * size.z, dim: sel.pos1.dim };
}

// =============================================================================
// 設計図のセル一覧（空気以外のブロックの局所座標＋Permutation）
// =============================================================================

function packLocal(size, x, y, z) {
  return (y * size.z + z) * size.x + x;
}

function unpackLocal(size, i) {
  const x = i % size.x;
  const rest = (i - x) / size.x;
  const z = rest % size.z;
  const y = (rest - z) / size.z;
  return { x, y, z };
}

/**
 * 設計図の中身を1度だけ走査して、空気以外のブロックの一覧を作る。
 * runJob で数tickに分割するので、毎tickの全走査にはならない。
 */
function buildCells(id) {
  if (cellCache.has(id)) return Promise.resolve(cellCache.get(id));
  if (cellBuilding.has(id)) {
    // 既に構築中。完了までポーリングで待つ（1秒に2回）。
    return new Promise((resolve) => {
      const handle = system.runInterval(() => {
        if (cellCache.has(id)) {
          system.clearRun(handle);
          resolve(cellCache.get(id));
        } else if (!cellBuilding.has(id)) {
          system.clearRun(handle);
          resolve(undefined);
        }
      }, 10);
    });
  }

  const structure = getStructure(id);
  if (!structure) return Promise.resolve(undefined);

  cellBuilding.add(id);
  const size = structure.size;
  const cells = [];

  return new Promise((resolve) => {
    function* job() {
      let ops = 0;
      for (let y = 0; y < size.y; y++) {
        for (let z = 0; z < size.z; z++) {
          for (let x = 0; x < size.x; x++) {
            let perm;
            try {
              perm = structure.getBlockPermutation({ x, y, z });
            } catch (err) {
              warn("buildCells.getBlockPermutation", err);
              perm = undefined;
            }
            if (perm && perm.type.id !== "minecraft:air") {
              cells.push({ i: packLocal(size, x, y, z), perm });
            }
            if (++ops >= JOB_CHUNK) {
              ops = 0;
              yield;
            }
          }
        }
      }
      cellBuilding.delete(id);
      const data = { size, cells };
      cellCache.set(id, data);
      resolve(data);
    }
    system.runJob(job());
  });
}

function dropCells(id) {
  cellCache.delete(id);
  cellBuilding.delete(id);
}

// =============================================================================
// 設置判定
// =============================================================================

/**
 * 設計図側の BlockPermutation と、ワールドの実ブロックを1件ずつ比較する（FR-3）。
 * 種類が同じでも状態（向き・半分など）が違えば未設置として扱う。
 */
function permutationMatches(perm, block) {
  if (block.typeId !== perm.type.id) return false;
  let want;
  let have;
  try {
    want = perm.getAllStates();
    have = block.permutation.getAllStates();
  } catch (err) {
    warn("permutationMatches", err);
    return block.typeId === perm.type.id;
  }
  for (const key of Object.keys(want)) {
    if (have[key] !== want[key]) return false;
  }
  return true;
}

/**
 * 設計図全体をスキャンして、設置済み数・不足ブロックの内訳を数える。
 * runJob で分割実行するため1tickにまとめて走らせない。
 */
function scanBlueprint(data, origin, dimension) {
  return new Promise((resolve) => {
    const result = { total: 0, placed: 0, skipped: 0, missing: new Map() };
    function* job() {
      let ops = 0;
      for (const cell of data.cells) {
        const l = unpackLocal(data.size, cell.i);
        const pos = { x: origin.x + l.x, y: origin.y + l.y, z: origin.z + l.z };
        let block;
        try {
          block = dimension.getBlock(pos);
        } catch {
          block = undefined; // 未読み込みチャンク／建築高度の範囲外
        }
        if (!block) {
          result.skipped++;
        } else {
          result.total++;
          if (permutationMatches(cell.perm, block)) {
            result.placed++;
          } else {
            const id = cell.perm.type.id;
            result.missing.set(id, (result.missing.get(id) ?? 0) + 1);
          }
        }
        if (++ops >= JOB_CHUNK) {
          ops = 0;
          yield;
        }
      }
      resolve(result);
    }
    system.runJob(job());
  });
}

// =============================================================================
// FR-2 ゴースト表示
// =============================================================================

function getGhostState(player) {
  const state = readJson(player, DP_GHOST);
  if (!state || typeof state.blueprintId !== "string" || !state.origin) return undefined;
  return state;
}

function setGhostState(player, state) {
  writeJson(player, DP_GHOST, state);
  ghostCursor.delete(player.id);
}

function clearGhostState(player) {
  player.setDynamicProperty(DP_GHOST, undefined);
  ghostCursor.delete(player.id);
}

/**
 * ゴーストの1パス分を描画する。
 * 全ブロックを毎回舐めるのではなく、カーソルを進めながら GHOST_BUDGET 件だけ判定し、
 * プレイヤーの近くにある未設置ブロックにパーティクルを出す。
 */
function renderGhost(player) {
  const state = getGhostState(player);
  if (!state || state.visible === false) return;

  const data = cellCache.get(state.blueprintId);
  if (!data) {
    // まだセル一覧が無い＝ワールド再読み込み直後など。バックグラウンドで構築する。
    if (!cellBuilding.has(state.blueprintId)) {
      buildCells(state.blueprintId).then((built) => {
        if (!built) clearGhostState(player);
      });
    }
    return;
  }

  const dimension = player.dimension;
  const origin = state.origin;
  const eye = player.location;
  const radiusSq = GHOST_RADIUS * GHOST_RADIUS;

  let cursor = ghostCursor.get(player.id) ?? 0;
  if (cursor >= data.cells.length) cursor = 0;

  let checked = 0;
  let drawn = 0;
  while (checked < GHOST_BUDGET && drawn < GHOST_PARTICLE_LIMIT && data.cells.length > 0) {
    const cell = data.cells[cursor];
    cursor = (cursor + 1) % data.cells.length;
    checked++;

    const l = unpackLocal(data.size, cell.i);
    const cx = origin.x + l.x + 0.5;
    const cy = origin.y + l.y + 0.5;
    const cz = origin.z + l.z + 0.5;
    const dx = cx - eye.x;
    const dy = cy - eye.y;
    const dz = cz - eye.z;
    if (dx * dx + dy * dy + dz * dz > radiusSq) continue;

    let block;
    try {
      block = dimension.getBlock({ x: origin.x + l.x, y: origin.y + l.y, z: origin.z + l.z });
    } catch {
      // チャンクがアンロードされている。この tick はここで打ち切り、次回に持ち越す。
      break;
    }
    if (!block) continue;
    if (permutationMatches(cell.perm, block)) continue;

    try {
      dimension.spawnParticle(PARTICLE_MISSING, { x: cx, y: cy, z: cz });
      drawn++;
    } catch {
      break; // 描画できない状況（未読み込み等）なら次回に回す
    }
  }
  ghostCursor.set(player.id, cursor);
}

// =============================================================================
// FR-6 ガイドライン
// =============================================================================

function renderGuide(player, guide) {
  const dimension = player.dimension;
  let drawn = 0;

  const spawn = (x, y, z, particle) => {
    if (drawn >= GUIDE_PARTICLE_LIMIT) return false;
    try {
      dimension.spawnParticle(particle, { x: x + 0.5, y: y + 0.5, z: z + 0.5 });
    } catch {
      return false; // 未読み込み等。以降は諦める
    }
    drawn++;
    return true;
  };

  const o = guide.origin;
  const step = guide.spacing;

  if (guide.mode === "line") {
    for (let d = -GUIDE_EXTENT; d <= GUIDE_EXTENT; d++) {
      const major = d % step === 0;
      const particle = major ? PARTICLE_MARK : PARTICLE_GUIDE;
      const ok =
        guide.axis === "x"
          ? spawn(o.x + d, o.y, o.z, particle)
          : guide.axis === "y"
            ? spawn(o.x, o.y + d, o.z, particle)
            : spawn(o.x, o.y, o.z + d, particle);
      if (!ok) return;
    }
    return;
  }

  // グリッド: 指定軸に垂直な平面に、spacing 間隔の格子点を打つ。
  // さらに基準点を通る2本の軸線は連続で描いて向きが分かるようにする。
  const axes =
    guide.axis === "x"
      ? [
          [0, 1, 0],
          [0, 0, 1],
        ]
      : guide.axis === "y"
        ? [
            [1, 0, 0],
            [0, 0, 1],
          ]
        : [
            [1, 0, 0],
            [0, 1, 0],
          ];
  const [u, v] = axes;

  for (let d = -GUIDE_EXTENT; d <= GUIDE_EXTENT; d++) {
    if (!spawn(o.x + u[0] * d, o.y + u[1] * d, o.z + u[2] * d, PARTICLE_GUIDE)) return;
    if (!spawn(o.x + v[0] * d, o.y + v[1] * d, o.z + v[2] * d, PARTICLE_GUIDE)) return;
  }
  for (let a = -GUIDE_EXTENT; a <= GUIDE_EXTENT; a += step) {
    for (let b = -GUIDE_EXTENT; b <= GUIDE_EXTENT; b += step) {
      if (a === 0 && b === 0) continue;
      const x = o.x + u[0] * a + v[0] * b;
      const y = o.y + u[1] * a + v[1] * b;
      const z = o.z + u[2] * a + v[2] * b;
      if (!spawn(x, y, z, PARTICLE_MARK)) return;
    }
  }
}

// =============================================================================
// 描画ループ（10tick間隔）
// =============================================================================

system.runInterval(() => {
  safe("renderLoop", () => {
    const now = system.currentTick;
    for (const player of world.getAllPlayers()) {
      safe("renderGhost", () => renderGhost(player));

      const guide = guides.get(player.id);
      if (!guide) continue;
      if (now >= guide.expiresAt) {
        guides.delete(player.id);
        safe("guide expire", () => player.sendMessage("§7ガイドラインの表示時間が終了しました。"));
      } else {
        safe("renderGuide", () => renderGuide(player, guide));
      }
    }
  });
}, RENDER_INTERVAL);

// =============================================================================
// FR-5 ミラー設置
// =============================================================================

const MIRROR_X = { east: "west", west: "east" };
const MIRROR_Z = { north: "south", south: "north" };

/**
 * 対称側に置くブロックの状態を作る。
 * 向きを持つブロック（階段・トラップドア等）は反転軸に応じて向きも反転させる。
 * 反転できない状態はそのままコピーする（「同一ブロック」を置くのが原則）。
 */
function mirrorPermutation(perm, axis) {
  try {
    const states = perm.getAllStates();
    const next = { ...states };
    let changed = false;

    const dir = states["minecraft:cardinal_direction"];
    if (typeof dir === "string") {
      const flipped = axis === "x" ? MIRROR_X[dir] : axis === "z" ? MIRROR_Z[dir] : undefined;
      if (flipped) {
        next["minecraft:cardinal_direction"] = flipped;
        changed = true;
      }
    }
    if (axis === "y") {
      const half = states["minecraft:vertical_half"];
      if (typeof half === "string") {
        next["minecraft:vertical_half"] = half === "bottom" ? "top" : "bottom";
        changed = true;
      }
      if (typeof states["upside_down_bit"] === "boolean") {
        next["upside_down_bit"] = !states["upside_down_bit"];
        changed = true;
      }
    }

    if (!changed) return perm;
    return BlockPermutation.resolve(perm.type.id, next);
  } catch (err) {
    warn("mirrorPermutation", err);
    return perm;
  }
}

function mirrorPosition(pos, mirror) {
  if (mirror.axis === "x") return { x: 2 * mirror.origin.x - pos.x, y: pos.y, z: pos.z };
  if (mirror.axis === "y") return { x: pos.x, y: 2 * mirror.origin.y - pos.y, z: pos.z };
  return { x: pos.x, y: pos.y, z: 2 * mirror.origin.z - pos.z };
}

/** インベントリから typeId を1個減らす。減らせたら true。 */
function consumeOne(container, typeId) {
  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    if (!item || item.typeId !== typeId) continue;
    if (item.amount > 1) {
      item.amount -= 1;
      container.setItem(slot, item);
    } else {
      container.setItem(slot, undefined);
    }
    return true;
  }
  return false;
}

function countItem(container, typeId) {
  let total = 0;
  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    if (item && item.typeId === typeId) total += item.amount;
  }
  return total;
}

function getMirror(player) {
  const mirror = readJson(player, DP_MIRROR);
  if (!mirror || !mirror.axis || !mirror.origin) return undefined;
  return mirror;
}

world.afterEvents.playerPlaceBlock.subscribe((ev) => {
  const player = ev.player;
  if (!player) return;

  // クリエイティブでは消費が発生しないため、ミラー設置も行わない（仕様書 FR-5）。
  if (isCreative(player)) return;

  const mirror = getMirror(player);
  if (!mirror) return;

  const pos = { ...ev.block.location };
  const target = mirrorPosition(pos, mirror);
  if (target.x === pos.x && target.y === pos.y && target.z === pos.z) return; // 基準面上

  // 後続の処理でワールドを書き換えるので、イベント処理の外へ逃がす。
  const perm = ev.block.permutation;
  const dimension = ev.dimension;
  const blockTypeId = ev.block.typeId;

  let handTypeId;
  safe("mirror hand", () => {
    const equippable = player.getComponent("minecraft:equippable");
    handTypeId = equippable?.getEquipment(EquipmentSlot.Mainhand)?.typeId;
  });

  system.run(() => {
    safe("mirrorPlace", () => {
      // 未読み込みチャンクや建築高度の外は「起きて当たり前」なので、
      // コンテンツログに警告を出さず黙って諦める。
      let dest;
      try {
        dest = dimension.getBlock(target);
      } catch {
        return;
      }
      if (!dest) return;
      // 対称先が空気でなければ上書きしない（仕様書 第7章）。
      if (!dest.isAir) return;

      const inventory = player.getComponent("minecraft:inventory");
      const container = inventory?.container;
      if (!container) return;

      // 手に持っている物（＝今まさに置いた物）を優先し、無ければブロックの識別子で探す。
      const candidates = [];
      if (handTypeId) candidates.push(handTypeId);
      if (!candidates.includes(blockTypeId)) candidates.push(blockTypeId);

      const usable = candidates.find((id) => countItem(container, id) > 0);
      if (!usable) {
        // 在庫が無い。本来の設置は妨げず、対称設置だけスキップして1回だけ通知する。
        if (!mirrorWarned.has(player.id)) {
          mirrorWarned.add(player.id);
          player.sendMessage("§eミラー設置分の在庫が不足しています。（以降この警告は出しません）");
        }
        return;
      }

      if (!consumeOne(container, usable)) return;
      dest.setPermutation(mirrorPermutation(perm, mirror.axis));
    });
  });
});

// =============================================================================
// FR-7 集合テレポート
// =============================================================================

function rallyTeleport(player) {
  const now = system.currentTick;
  const last = player.getDynamicProperty(DP_RALLY_CD);
  if (typeof last === "number" && last <= now && now - last < RALLY_COOLDOWN_TICKS) {
    const remain = Math.ceil((RALLY_COOLDOWN_TICKS - (now - last)) / TPS);
    player.sendMessage(`§c集合テレポートはクールダウン中です。あと ${remain} 秒待ってください。`);
    return;
  }

  const others = world.getAllPlayers().filter((p) => p.id !== player.id);
  if (others.length === 0) {
    player.sendMessage("§e他に参加者がいません。");
    return;
  }

  const destination = player.location;
  const dimension = player.dimension;
  let moved = 0;
  for (const other of others) {
    const ok = safe("rally teleport", () => {
      // 溶岩の上・窒息座標などの安全判定はバニラの teleport 処理に委ねる（仕様書 FR-7）。
      other.teleport(destination, { dimension });
      return true;
    });
    if (ok) {
      moved++;
      other.sendMessage(`§a${player.name} の現在地へ集合しました。`);
    }
  }

  player.setDynamicProperty(DP_RALLY_CD, now);
  player.sendMessage(`§a${moved} 人を現在地へ集合させました。`);
}

// =============================================================================
// UI: メインメニュー
// =============================================================================

function openMainMenu(player) {
  const sel = getSelection(player);
  const range = selectionRange(sel);
  const mirror = getMirror(player);
  const ghost = getGhostState(player);
  const ghostName = ghost ? findBlueprint(ghost.blueprintId)?.name : undefined;

  const lines = [
    `選択範囲: ${range ? `${range.size.x} x ${range.size.y} x ${range.size.z}` : "未設定"}`,
    `ミラー設置: ${mirror ? `${mirror.axis.toUpperCase()}軸 / ${vecText(mirror.origin)}` : "無効"}`,
    `ゴースト表示: ${ghost && ghost.visible !== false && ghostName ? ghostName : "なし"}`,
  ];

  const form = new ActionFormData()
    .title("建築支援メニュー")
    .body(lines.join("\n"))
    .button("設計図管理")
    .button("ミラー設定")
    .button("ガイドライン表示")
    .button("集合テレポート");

  showForm(form, player)
    .then((res) => {
      if (res.canceled) return;
      if (res.selection === 0) openBlueprintMenu(player);
      else if (res.selection === 1) openMirrorForm(player);
      else if (res.selection === 2) openGuideForm(player);
      else if (res.selection === 3) openRallyConfirm(player);
    })
    .catch((err) => warn("openMainMenu", err));
}

// =============================================================================
// UI: 設計図管理
// =============================================================================

function openBlueprintMenu(player) {
  const sel = getSelection(player);
  const range = selectionRange(sel);
  const list = loadBlueprints();

  let body;
  if (!sel.pos1 && !sel.pos2) {
    body = "始点・終点が未設定です。\n設計図ツールでブロックを左クリックすると始点、右クリックすると終点になります。";
  } else if (!range) {
    body = `始点: ${sel.pos1 ? vecText(sel.pos1) : "未設定"}\n終点: ${sel.pos2 ? vecText(sel.pos2) : "未設定"}\n§c始点と終点のディメンションが違います。`;
  } else {
    body =
      `始点: ${vecText(sel.pos1)}\n終点: ${vecText(sel.pos2)}\n` +
      `範囲: ${range.size.x} x ${range.size.y} x ${range.size.z} （${range.volume} ブロック）\n` +
      `ディメンション: ${dimensionNameJa(range.dim)}`;
  }

  const form = new ActionFormData()
    .title("設計図管理")
    .body(body)
    .button("この範囲を設計図として保存")
    .button(`保存済みの設計図一覧（${list.length} 件）`)
    .button("現在地を始点にする")
    .button("現在地を終点にする")
    .button("戻る");

  showForm(form, player)
    .then((res) => {
      if (res.canceled) return;
      if (res.selection === 0) startSaveBlueprint(player);
      else if (res.selection === 1) openBlueprintList(player);
      else if (res.selection === 2 || res.selection === 3) {
        const which = res.selection === 2 ? 1 : 2;
        const block = player.dimension.getBlock(floorVec(player.location));
        if (!block) {
          player.sendMessage("§c現在地のブロックを取得できませんでした。");
          openBlueprintMenu(player);
          return;
        }
        setSelectionPoint(player, which, block);
        openBlueprintMenu(player);
      } else openMainMenu(player);
    })
    .catch((err) => warn("openBlueprintMenu", err));
}

// ---- FR-1 設計図保存 ---------------------------------------------------------

function startSaveBlueprint(player) {
  const sel = getSelection(player);
  const range = selectionRange(sel);

  if (!range) {
    const message = !sel.pos1 || !sel.pos2
      ? "先に始点と終点を指定してください。"
      : "始点と終点が別のディメンションにあります。";
    showNotice(player, "設計図を保存できません", message, () => openBlueprintMenu(player));
    return;
  }

  // FR-1（異常系）: 1辺が MAX_SIDE を超えたら保存を拒否する。
  if (range.size.x > MAX_SIDE || range.size.y > MAX_SIDE || range.size.z > MAX_SIDE) {
    showNotice(
      player,
      "設計図を保存できません",
      `範囲が大きすぎます（最大 ${MAX_SIDE}x${MAX_SIDE}x${MAX_SIDE}）。\n` +
        `指定された範囲: ${range.size.x} x ${range.size.y} x ${range.size.z}`,
      () => openBlueprintMenu(player)
    );
    return;
  }

  const form = new ModalFormData()
    .title("設計図を保存")
    .textField(
      `名前（${NAME_MIN}〜${NAME_MAX}文字）\n範囲: ${range.size.x} x ${range.size.y} x ${range.size.z}`,
      "例: 倉庫、東の塔"
    );

  showForm(form, player)
    .then((res) => {
      if (res.canceled) {
        openBlueprintMenu(player);
        return;
      }
      const name = (res.formValues?.[0] ?? "").toString().trim().slice(0, NAME_MAX);
      if (name.length < NAME_MIN) {
        showNotice(player, "設計図を保存できません", "名前を入力してください。", () =>
          startSaveBlueprint(player)
        );
        return;
      }

      const list = loadBlueprints();
      const existing = list.find((b) => b.name === name);
      if (existing) {
        // 第7章: 同名なら上書き確認を出し、「はい」のときだけ既存を消して保存し直す。
        const confirm = new ActionFormData()
          .title("上書きの確認")
          .body(`「${name}」は既に保存されています。\n上書きしますか？（元のデータは削除されます）`)
          .button("はい（上書きする）")
          .button("いいえ");
        showForm(confirm, player)
          .then((c) => {
            if (c.canceled || c.selection !== 0) {
              openBlueprintMenu(player);
              return;
            }
            deleteBlueprintData(existing.id);
            const rest = loadBlueprints().filter((b) => b.id !== existing.id);
            saveBlueprints(rest);
            commitBlueprint(player, name, range, rest);
          })
          .catch((err) => warn("overwrite confirm", err));
        return;
      }

      commitBlueprint(player, name, range, list);
    })
    .catch((err) => warn("startSaveBlueprint", err));
}

function commitBlueprint(player, name, range, list) {
  const id = makeBlueprintId(name, list);
  const dimension = world.getDimension(range.dim);

  const created = safe("createFromWorld", () => {
    world.structureManager.createFromWorld(id, dimension, range.min, range.max, {
      saveMode: StructureSaveMode.World,
    });
    return true;
  });

  if (!created) {
    showNotice(
      player,
      "設計図を保存できません",
      "保存に失敗しました。範囲のチャンクがすべて読み込まれているか確認してください。",
      () => openBlueprintMenu(player)
    );
    return;
  }

  list.push({
    id,
    name,
    size: { ...range.size },
    createdBy: player.name,
    createdAt: Date.now(),
  });
  saveBlueprints(list);
  dropCells(id);

  player.sendMessage(
    `§a設計図「${name}」を保存しました（${range.size.x} x ${range.size.y} x ${range.size.z}）。`
  );
  openBlueprintList(player);
}

function deleteBlueprintData(id) {
  try {
    world.structureManager.delete(id);
  } catch {
    // 実体が既に無いケースは想定内（メタデータだけ残っていた等）。一覧側は呼び出し元で消す。
  }
  dropCells(id);
}

// ---- 設計図一覧 --------------------------------------------------------------

function openBlueprintList(player) {
  const list = loadBlueprints();
  const form = new ActionFormData().title("保存済みの設計図");

  if (list.length === 0) {
    // 第6章: 0件なら1行メッセージのみ。
    form.body("保存済みの設計図がありません").button("戻る");
    showForm(form, player)
      .then(() => openBlueprintMenu(player))
      .catch((err) => warn("openBlueprintList(empty)", err));
    return;
  }

  const ghost = getGhostState(player);
  form.body("設計図を選ぶと、ゴースト表示・進捗確認・持ち寄りリストを操作できます。");
  for (const bp of list) {
    const active = ghost && ghost.visible !== false && ghost.blueprintId === bp.id ? " §a[表示中]" : "";
    form.button(`${bp.name}${active}\n§7${bp.size.x} x ${bp.size.y} x ${bp.size.z} ・ ${bp.createdBy}`);
  }
  form.button("戻る");

  showForm(form, player)
    .then((res) => {
      if (res.canceled) return;
      if (res.selection === list.length) {
        openBlueprintMenu(player);
        return;
      }
      openBlueprintDetail(player, list[res.selection].id);
    })
    .catch((err) => warn("openBlueprintList", err));
}

function openBlueprintDetail(player, id) {
  const bp = findBlueprint(id);
  if (!bp) {
    openBlueprintList(player);
    return;
  }

  const ghost = getGhostState(player);
  const showing = ghost && ghost.visible !== false && ghost.blueprintId === id;

  const body = [
    `名前: ${bp.name}`,
    `サイズ: ${bp.size.x} x ${bp.size.y} x ${bp.size.z}`,
    `作成者: ${bp.createdBy}`,
    `作成日時: ${formatDate(bp.createdAt)}`,
    `ゴースト表示: ${showing ? `ON（基準 ${vecText(ghost.origin)}）` : "OFF"}`,
  ].join("\n");

  const form = new ActionFormData()
    .title(bp.name)
    .body(body)
    .button(showing ? "ゴースト表示をOFFにする" : "ゴースト表示をONにする")
    .button("進捗を確認")
    .button("持ち寄りリストを作成")
    .button("この設計図を削除")
    .button("戻る");

  showForm(form, player)
    .then((res) => {
      if (res.canceled) return;
      if (res.selection === 0) {
        if (showing) {
          clearGhostState(player);
          player.sendMessage(`§7「${bp.name}」のゴースト表示をOFFにしました。`);
          openBlueprintDetail(player, id);
        } else {
          openGhostOriginForm(player, id);
        }
      } else if (res.selection === 1) {
        withGhostScan(player, id, (bpMeta, result) => showProgress(player, bpMeta, result));
      } else if (res.selection === 2) {
        withGhostScan(player, id, (bpMeta, result) => openShareForm(player, bpMeta, result));
      } else if (res.selection === 3) {
        confirmDeleteBlueprint(player, id);
      } else {
        openBlueprintList(player);
      }
    })
    .catch((err) => warn("openBlueprintDetail", err));
}

function openGhostOriginForm(player, id) {
  const bp = findBlueprint(id);
  if (!bp) return;
  const here = floorVec(player.location);

  const form = new ModalFormData()
    .title("ゴースト表示の基準座標")
    .textField("X（範囲の最小角）", "例: 100", { defaultValue: String(here.x) })
    .textField("Y（範囲の最小角）", "例: 64", { defaultValue: String(here.y) })
    .textField("Z（範囲の最小角）", "例: -30", { defaultValue: String(here.z) });

  showForm(form, player)
    .then((res) => {
      if (res.canceled) {
        openBlueprintDetail(player, id);
        return;
      }
      const values = (res.formValues ?? []).map((v) => Number.parseInt(String(v), 10));
      if (values.some((n) => !Number.isFinite(n))) {
        showNotice(player, "座標が不正です", "X・Y・Z には整数を入力してください。", () =>
          openGhostOriginForm(player, id)
        );
        return;
      }
      const origin = { x: values[0], y: values[1], z: values[2] };
      setGhostState(player, { blueprintId: id, origin, visible: true });
      player.sendMessage(`§a「${bp.name}」のゴースト表示をONにしました（基準 ${vecText(origin)}）。`);
      player.sendMessage("§7未設置のブロックが緑の粒で表示されます（0.5秒ごとに更新）。");

      // 表示をONにした直後に1度だけ照合し、何ブロック残っているかを伝える。
      // 既に完成している場所を指定すると粒が1つも出ないため、
      // 「壊れている」と誤解されないようにここで件数を出しておく。
      buildCells(id).then((data) => {
        if (!data) {
          clearGhostState(player);
          player.sendMessage("§c設計図の実体が見つかりませんでした。一覧から削除してください。");
          return;
        }
        scanBlueprint(data, origin, player.dimension).then((result) => {
          const remaining = result.total - result.placed;
          if (remaining === 0) {
            player.sendMessage("§7この基準座標では未設置のブロックがありません（表示する粒はありません）。");
          } else {
            player.sendMessage(`§7未設置は ${remaining} / ${result.total} ブロックです。`);
          }
        });
      });
      openBlueprintDetail(player, id);
    })
    .catch((err) => warn("openGhostOriginForm", err));
}

/**
 * FR-3 / FR-4 はどちらも「ゴースト表示中の設計図」が対象。
 * 基準座標はゴースト状態から取り、スキャン完了後にコールバックを呼ぶ。
 */
function withGhostScan(player, id, callback) {
  const bp = findBlueprint(id);
  if (!bp) return;

  const ghost = getGhostState(player);
  if (!ghost || ghost.visible === false || ghost.blueprintId !== id) {
    showNotice(
      player,
      bp.name,
      "先にゴースト表示をONにして、基準座標を決めてください。",
      () => openBlueprintDetail(player, id)
    );
    return;
  }

  player.sendMessage("§7設計図を照合しています…");
  buildCells(id).then((data) => {
    if (!data) {
      showNotice(player, bp.name, "設計図の実体が見つかりませんでした。", () =>
        openBlueprintDetail(player, id)
      );
      return;
    }
    scanBlueprint(data, ghost.origin, player.dimension).then((result) => {
      callback(bp, result);
    });
  });
}

// ---- FR-3 進捗チェック -------------------------------------------------------

function showProgress(player, bp, result) {
  const percent = result.total === 0 ? 0 : Math.round((result.placed / result.total) * 100);
  const lines = [
    `設置済みブロック数: ${result.placed}`,
    `総ブロック数: ${result.total}`,
    `完成率: ${percent}%`,
  ];
  if (result.skipped > 0) {
    lines.push("", `§7※ 未読み込みチャンクなどの ${result.skipped} ブロックは判定から除外しました。`);
  }
  showNotice(player, `${bp.name} の進捗`, lines.join("\n"), () =>
    openBlueprintDetail(player, bp.id)
  );
}

// ---- FR-4 資材配分リスト -----------------------------------------------------

function openShareForm(player, bp, result) {
  if (result.missing.size === 0) {
    showNotice(player, `${bp.name} の持ち寄りリスト`, "不足しているブロックはありません。", () =>
      openBlueprintDetail(player, bp.id)
    );
    return;
  }

  const members = world.getAllPlayers();
  const form = new ModalFormData().title("参加メンバーを選択");
  for (const member of members) {
    form.toggle(member.name, { defaultValue: member.id === player.id });
  }

  showForm(form, player)
    .then((res) => {
      if (res.canceled) {
        openBlueprintDetail(player, bp.id);
        return;
      }
      const chosen = members.filter((_, i) => res.formValues?.[i] === true);
      if (chosen.length === 0) {
        showNotice(player, "参加メンバーを選択", "1人以上選んでください。", () =>
          openShareForm(player, bp, result)
        );
        return;
      }
      showShareResult(player, bp, result, chosen);
    })
    .catch((err) => warn("openShareForm", err));
}

function showShareResult(player, bp, result, members) {
  const containers = members.map((m) => {
    const inventory = safe("share inventory", () => m.getComponent("minecraft:inventory"));
    return inventory?.container;
  });

  const all = [...result.missing.entries()].sort((a, b) => b[1] - a[1]);
  // フォームの本文が長すぎると読めなくなるので、多い順に上位だけ出す。
  const entries = all.slice(0, SHARE_LIST_LIMIT);
  const lines = [
    `対象メンバー（${members.length}人）: ${members.map((m) => m.name).join("、")}`,
    "",
  ];

  for (const [typeId, needed] of entries) {
    let held = 0;
    for (const container of containers) {
      if (container) held += countItem(container, typeId);
    }
    const shortage = Math.max(0, needed - held);

    lines.push(`§f${blockNameJa(typeId)}`);
    lines.push(`§7  必要 ${needed} / 所持 ${held} / 不足 ${shortage}`);

    if (shortage === 0) {
      lines.push("§a  必要数は揃っています");
    } else if (members.length === 1) {
      // 第7章: 自分1人だけなら割り算をせず不足数をそのまま出す。
      lines.push(`§e  ${members[0].name}: ${shortage}`);
    } else {
      const each = Math.floor(shortage / members.length);
      const remainder = shortage % members.length;
      const parts = members.map(
        // 割り切れない端数は先頭のプレイヤーに寄せる（第7章）。
        (m, i) => `${m.name}: ${each + (i === 0 ? remainder : 0)}`
      );
      lines.push(`§e  ${parts.join(" / ")}`);
    }
    lines.push("");
  }

  if (all.length > entries.length) {
    lines.push(`§7…ほか ${all.length - entries.length} 種類（不足数の多い順に ${SHARE_LIST_LIMIT} 種類まで表示）`);
  }

  showNotice(player, `${bp.name} の持ち寄りリスト`, lines.join("\n"), () =>
    openBlueprintDetail(player, bp.id)
  );
}

// ---- 削除 --------------------------------------------------------------------

function confirmDeleteBlueprint(player, id) {
  const bp = findBlueprint(id);
  if (!bp) return;

  const form = new ActionFormData()
    .title("削除の確認")
    .body(`設計図「${bp.name}」を削除しますか？\nこの操作は取り消せません。`)
    .button("はい（削除する）")
    .button("いいえ");

  showForm(form, player)
    .then((res) => {
      if (res.canceled || res.selection !== 0) {
        openBlueprintDetail(player, id);
        return;
      }
      deleteBlueprintData(id);
      saveBlueprints(loadBlueprints().filter((b) => b.id !== id));

      // この設計図を表示していたプレイヤーのゴースト状態も片付ける。
      for (const other of world.getAllPlayers()) {
        const ghost = getGhostState(other);
        if (ghost && ghost.blueprintId === id) clearGhostState(other);
      }
      player.sendMessage(`§7設計図「${bp.name}」を削除しました。`);
      openBlueprintList(player);
    })
    .catch((err) => warn("confirmDeleteBlueprint", err));
}

// =============================================================================
// UI: FR-5 ミラー設定
// =============================================================================

/** ドロップダウンの並び順と対応する軸。ミラー設定とガイドラインで共用する。 */
const AXES = ["x", "y", "z"];

function openMirrorForm(player) {
  const current = getMirror(player);
  const here = floorVec(player.location);
  const origin = current?.origin ?? here;
  const axisIndex = current ? Math.max(0, AXES.indexOf(current.axis)) : 0;

  const form = new ModalFormData()
    .title("ミラー設定")
    .toggle("ミラー設置を有効にする", { defaultValue: Boolean(current) })
    .dropdown(
      "基準面",
      ["X軸（東西方向に反転）", "Y軸（上下方向に反転）", "Z軸（南北方向に反転）"],
      { defaultValueIndex: axisIndex }
    )
    .textField("基準座標 X", "例: 100", { defaultValue: String(origin.x) })
    .textField("基準座標 Y", "例: 64", { defaultValue: String(origin.y) })
    .textField("基準座標 Z", "例: -30", { defaultValue: String(origin.z) });

  showForm(form, player)
    .then((res) => {
      if (res.canceled) {
        openMainMenu(player);
        return;
      }
      const values = res.formValues ?? [];
      const enabled = values[0] === true;

      if (!enabled) {
        player.setDynamicProperty(DP_MIRROR, undefined);
        mirrorWarned.delete(player.id);
        player.sendMessage("§7ミラー設置を無効にしました。");
        openMainMenu(player);
        return;
      }

      const axis = AXES[Number(values[1]) || 0];
      const coords = [values[2], values[3], values[4]].map((v) => Number.parseInt(String(v), 10));
      if (coords.some((n) => !Number.isFinite(n))) {
        showNotice(player, "座標が不正です", "基準座標には整数を入力してください。", () =>
          openMirrorForm(player)
        );
        return;
      }

      const mirrorOrigin = { x: coords[0], y: coords[1], z: coords[2] };
      writeJson(player, DP_MIRROR, { axis, origin: mirrorOrigin });
      mirrorWarned.delete(player.id);

      player.sendMessage(
        `§aミラー設置を有効にしました（${axis.toUpperCase()}軸 / 基準 ${vecText(mirrorOrigin)}）。`
      );
      if (isCreative(player)) {
        player.sendMessage("§7クリエイティブでは資材が消費されないため、ミラー設置は動作しません。");
      } else {
        player.sendMessage("§7ブロックを置くと対称位置にも設置され、資材は合計2個消費されます。");
      }
      openMainMenu(player);
    })
    .catch((err) => warn("openMirrorForm", err));
}

// =============================================================================
// UI: FR-6 ガイドライン表示
// =============================================================================

function openGuideForm(player) {
  const here = floorVec(player.location);

  const form = new ModalFormData()
    .title("ガイドライン表示")
    .dropdown("種類", ["直線", "グリッド"], { defaultValueIndex: 0 })
    .dropdown("方向", ["X軸（東西）", "Y軸（上下）", "Z軸（南北）"], { defaultValueIndex: 0 })
    .textField("基準点 X", "例: 100", { defaultValue: String(here.x) })
    .textField("基準点 Y", "例: 64", { defaultValue: String(here.y) })
    .textField("基準点 Z", "例: -30", { defaultValue: String(here.z) })
    // 範囲外の値はスライダーの制限で入力自体を防ぐ（仕様書 第7章）。
    .slider("間隔（ブロック）", 1, 16, { defaultValue: 5, valueStep: 1 })
    .slider("表示時間（秒）", 10, 300, { defaultValue: 30, valueStep: 10 });

  showForm(form, player)
    .then((res) => {
      if (res.canceled) {
        openMainMenu(player);
        return;
      }
      const values = res.formValues ?? [];
      const mode = Number(values[0]) === 1 ? "grid" : "line";
      const axis = AXES[Number(values[1]) || 0];
      const coords = [values[2], values[3], values[4]].map((v) => Number.parseInt(String(v), 10));
      if (coords.some((n) => !Number.isFinite(n))) {
        showNotice(player, "座標が不正です", "基準点には整数を入力してください。", () =>
          openGuideForm(player)
        );
        return;
      }
      const spacing = Math.min(16, Math.max(1, Number(values[5]) || 5));
      const seconds = Math.min(300, Math.max(10, Number(values[6]) || 30));

      guides.set(player.id, {
        mode,
        axis,
        origin: { x: coords[0], y: coords[1], z: coords[2] },
        spacing,
        expiresAt: system.currentTick + seconds * TPS,
      });

      player.sendMessage(
        `§a${mode === "grid" ? "グリッド" : "直線"}を表示します（${axis.toUpperCase()}軸 / 間隔 ${spacing} / ${seconds}秒）。`
      );
    })
    .catch((err) => warn("openGuideForm", err));
}

// =============================================================================
// UI: FR-7 集合テレポート
// =============================================================================

function openRallyConfirm(player) {
  const others = world.getAllPlayers().filter((p) => p.id !== player.id);
  const form = new ActionFormData()
    .title("集合テレポート")
    .body(
      others.length === 0
        ? "他に参加者がいません。"
        : `オンラインの ${others.length} 人（${others.map((p) => p.name).join("、")}）を自分の現在地へ呼び寄せます。`
    )
    .button("実行する")
    .button("やめる");

  showForm(form, player)
    .then((res) => {
      if (res.canceled || res.selection !== 0) {
        openMainMenu(player);
        return;
      }
      rallyTeleport(player);
    })
    .catch((err) => warn("openRallyConfirm", err));
}

// =============================================================================
// ガイドブック
// =============================================================================

/**
 * 目次を開く。
 * 安定版APIにはバニラの「書かれた本」へページを流し込む手段が無いため、
 * カスタムアイテム＋フォームUIで本を再現している。
 */
function openGuideBook(player) {
  const form = new ActionFormData()
    .title("建築支援ガイドブック")
    .body("読みたい項目を選んでください。");

  for (const section of BOOK_SECTIONS) form.button(section.title);
  form.button("パッチノート");
  form.button("制作者");
  form.button("閉じる");

  showForm(form, player)
    .then((res) => {
      if (res.canceled) return;
      const i = res.selection;
      if (i < BOOK_SECTIONS.length) {
        openBookPage(player, BOOK_SECTIONS[i].title, BOOK_SECTIONS[i].body);
      } else if (i === BOOK_SECTIONS.length) {
        openBookPage(player, "パッチノート", patchNotesBody());
      } else if (i === BOOK_SECTIONS.length + 1) {
        openBookPage(player, "制作者", creditsBody());
      }
    })
    .catch((err) => warn("openGuideBook", err));
}

function openBookPage(player, title, body) {
  const form = new ActionFormData().title(title).body(body).button("目次にもどる");
  showForm(form, player)
    .then(() => openGuideBook(player))
    .catch((err) => warn("openBookPage", err));
}

/** ガイドブックを1冊渡す。持ちきれなければ足元に落とす。 */
function giveGuideBook(player) {
  const stack = new ItemStack(`${NS}:guide_book`, 1);
  const container = player.getComponent("minecraft:inventory")?.container;
  if (container) {
    const leftover = container.addItem(stack);
    if (!leftover) return;
  }
  player.dimension.spawnItem(stack, player.location);
}

/** 初めてワールドに入ったプレイヤーにガイドブックを配る（1人につき1回だけ）。 */
world.afterEvents.playerSpawn.subscribe((ev) => {
  if (!ev.initialSpawn) return;
  const player = ev.player;
  if (!player) return;
  if (player.getDynamicProperty(DP_BOOK_GIVEN) === true) return;

  // スポーン直後はインベントリが用意できていないことがあるので、少し待ってから渡す。
  system.runTimeout(() => {
    safe("giveGuideBook", () => {
      if (player.getDynamicProperty(DP_BOOK_GIVEN) === true) return;
      giveGuideBook(player);
      player.setDynamicProperty(DP_BOOK_GIVEN, true);
      player.sendMessage("§a『建築支援ガイドブック』を渡しました。手に持って右クリックで開けます。");
    });
  }, BOOK_GIVE_DELAY);
});

// =============================================================================
// 汎用: 1行メッセージ表示
// =============================================================================

function showNotice(player, title, body, onClose) {
  const form = new ActionFormData().title(title).body(body).button("戻る");
  showForm(form, player)
    .then(() => {
      if (onClose) onClose();
    })
    .catch((err) => warn("showNotice", err));
}

// =============================================================================
// アイテムのカスタムコンポーネント
// =============================================================================

system.beforeEvents.startup.subscribe(({ itemComponentRegistry }) => {
  itemComponentRegistry.registerCustomComponent(`${NS}:blueprint_wand`, {
    onUseOn({ source, block }) {
      if (!source || !block) return;
      // スニーク＋右クリックでメニュー、通常の右クリックで終点を指定する。
      if (source.isSneaking) {
        system.run(() => safe("wand menu", () => openMainMenu(source)));
        return;
      }
      system.run(() => safe("wand pos2", () => setSelectionPoint(source, 2, block)));
    },
    onUse({ source }) {
      if (!source) return;
      system.run(() => safe("wand menu(air)", () => openMainMenu(source)));
    },
  });

  itemComponentRegistry.registerCustomComponent(`${NS}:rally_beacon`, {
    onUse({ source }) {
      if (!source) return;
      system.run(() => safe("rally beacon", () => rallyTeleport(source)));
    },
  });

  itemComponentRegistry.registerCustomComponent(`${NS}:guide_book`, {
    // 空中でもブロックに向けても、どちらの右クリックでも開けるようにする。
    onUse({ source }) {
      if (!source) return;
      system.run(() => safe("guide book", () => openGuideBook(source)));
    },
    onUseOn({ source }) {
      if (!source) return;
      system.run(() => safe("guide book(on)", () => openGuideBook(source)));
    },
  });
});

/** 設計図ツールで殴ったブロックを始点にする（破壊はさせない）。 */
world.beforeEvents.playerBreakBlock.subscribe((ev) => {
  if (ev.itemStack?.typeId !== `${NS}:blueprint_wand`) return;
  ev.cancel = true;

  const player = ev.player;
  const location = { ...ev.block.location };
  const dimensionId = ev.dimension.id;
  system.run(() => {
    safe("wand pos1", () => {
      const block = world.getDimension(dimensionId).getBlock(location);
      if (block) setSelectionPoint(player, 1, block);
    });
  });
});

/** プレイヤーが抜けたらメモリ上の状態を掃除する（永続化するものはDPに残る）。 */
world.afterEvents.playerLeave.subscribe((ev) => {
  ghostCursor.delete(ev.playerId);
  guides.delete(ev.playerId);
  mirrorWarned.delete(ev.playerId);
});
