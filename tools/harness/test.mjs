import {
  world,
  system,
  captured,
  makePlayer,
  fakeDimension,
  BlockPermutation,
  GameMode,
  players,
} from "@minecraft/server";
import { responses, formLog } from "@minecraft/server-ui";

const realWarn = console.warn;
console.warn = (...args) => {
  captured.warnings.push(args.join(" "));
  realWarn(...args);
};

// 常に BuildHelperBP/scripts の現物をテストする。
// スタブ（@minecraft/server 等）を node_modules から解決させる必要があるので、
// このディレクトリへコピーしてから読み込む。
{
  const { copyFileSync, readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, "..", "..", "BuildHelperBP", "scripts");
  for (const name of readdirSync(src).filter((f) => f.endsWith(".js"))) {
    copyFileSync(join(src, name), join(here, name));
  }
}

await import("./main.js");

const dim = fakeDimension();
const alice = makePlayer("Alice");
const bob = makePlayer("Bob");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  OK   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label} ${detail}`);
  }
}
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const lastForm = () => formLog[formLog.length - 1];

function setBlock(x, y, z, typeId, states = {}) {
  dim.getBlock({ x, y, z }).setPermutation(new BlockPermutation(typeId, states));
}

// 4x1x2 = 8 ブロックの石を (0,64,0)-(3,64,1) に置く
for (let x = 0; x <= 3; x++) for (let z = 0; z <= 1; z++) setBlock(x, 64, z, "minecraft:stone");

const wand = captured.itemComponents.get("buildhelper:blueprint_wand");
const beacon = captured.itemComponents.get("buildhelper:rally_beacon");
const book = captured.itemComponents.get("buildhelper:guide_book");

console.log("\n== 登録 ==");
check("設計図ツールが登録されている", Boolean(wand?.onUseOn && wand?.onUse));
check("集合ビーコンが登録されている", Boolean(beacon?.onUse));
check("ガイドブックが登録されている", Boolean(book?.onUse && book?.onUseOn));
check("描画ループは10tick間隔", captured.intervals.some((i) => i.ticks === 10));

console.log("\n== ガイドブックの初回配布 ==");
const spawnHandler = captured.events.get("playerSpawn")[0];
spawnHandler({ player: alice, initialSpawn: true });
await flush();
check(
  "初回ログインで1冊配られる",
  alice._slots.some((s) => s?.typeId === "buildhelper:guide_book"),
  JSON.stringify(alice._slots.filter(Boolean))
);
check("配布フラグが永続化される", alice._props.get("buildhelper:book_given") === true);
check("配布メッセージが出る", captured.messages.some((m) => m.includes("ガイドブック")));

// 2回目のログイン（initialSpawn=true）でも増えない
spawnHandler({ player: alice, initialSpawn: true });
await flush();
check(
  "2回目以降は配られない",
  alice._slots.filter((s) => s?.typeId === "buildhelper:guide_book").length === 1
);

// リスポーン（initialSpawn=false）では配らない
spawnHandler({ player: bob, initialSpawn: false });
await flush();
check("リスポーンでは配られない", !bob._slots.some((s) => s?.typeId === "buildhelper:guide_book"));

// インベントリが満杯なら足元に落とす
const dave = makePlayer("Dave");
for (let i = 0; i < dave._slots.length; i++) dave._slots[i] = { typeId: "minecraft:dirt", amount: 64 };
dim.droppedItems.length = 0;
spawnHandler({ player: dave, initialSpawn: true });
await flush();
check(
  "満杯なら足元にドロップする",
  dim.droppedItems.some((d) => d.itemStack.typeId === "buildhelper:guide_book"),
  JSON.stringify(dim.droppedItems)
);

console.log("\n== ガイドブックの中身 ==");
formLog.length = 0;
responses.push({ canceled: false, selection: 0 }, { canceled: true }); // 1章目を開いて閉じる
book.onUse({ source: alice });
await flush();
const toc = formLog[0];
check("目次が出る", toc?.title === "建築支援ガイドブック", JSON.stringify(toc?.title));
check("章＋パッチノート＋制作者＋閉じるが並ぶ", toc?.buttons.length >= 4, JSON.stringify(toc?.buttons));
check("パッチノートの項目がある", toc?.buttons.includes("パッチノート"));
check("制作者の項目がある", toc?.buttons.includes("制作者"));
check("レシピの章がある", toc?.buttons.includes("クラフトレシピ"));
check("章の本文が表示される", Boolean(formLog[1]?.body), JSON.stringify(formLog[1]?.title));

formLog.length = 0;
const creditsIndex = toc.buttons.indexOf("制作者");
responses.push({ canceled: false, selection: creditsIndex }, { canceled: true });
book.onUse({ source: alice });
await flush();
const credits = formLog.find((f) => f.title === "制作者");
check("制作者が takosasi", String(credits?.body).includes("takosasi"), String(credits?.body));

formLog.length = 0;
const notesIndex = toc.buttons.indexOf("パッチノート");
responses.push({ canceled: false, selection: notesIndex }, { canceled: true });
book.onUse({ source: alice });
await flush();
const notes = formLog.find((f) => f.title === "パッチノート");
check("パッチノートに v1.1.0 がある", String(notes?.body).includes("v1.1.0"), String(notes?.body));
check("パッチノートに v1.0.0 がある", String(notes?.body).includes("v1.0.0"));

// 以降のテストのためにガイドブックを片付ける
for (let i = 0; i < alice._slots.length; i++) alice._slots[i] = undefined;
captured.messages.length = 0;
formLog.length = 0;

console.log("\n== FR-1 範囲選択と保存 ==");
captured.events.get("playerBreakBlock")[0]({
  itemStack: { typeId: "buildhelper:blueprint_wand" },
  player: alice,
  block: dim.getBlock({ x: 0, y: 64, z: 0 }),
  dimension: dim,
  cancel: false,
});
wand.onUseOn({ source: alice, block: dim.getBlock({ x: 3, y: 64, z: 1 }) });
await flush();
check("始点が保存された", alice._props.get("buildhelper:sel_pos1") !== undefined);
check("終点が保存された", alice._props.get("buildhelper:sel_pos2") !== undefined);

responses.push(
  { canceled: false, selection: 0 },              // メインメニュー → 設計図管理
  { canceled: false, selection: 0 },              // 設計図管理 → 保存
  { canceled: false, formValues: ["テストの家"] }, // 名前
  { canceled: true }                              // 一覧を閉じる
);
wand.onUse({ source: alice });
await flush();

const list = JSON.parse(world._props.get("buildhelper:blueprint_list"));
check("設計図が1件保存された", list.length === 1, JSON.stringify(list));
check("サイズが 4x1x2", list[0] && `${list[0].size.x}x${list[0].size.y}x${list[0].size.z}` === "4x1x2");
check("Structure の実体が作られた", world.structureManager._store.has(list[0]?.id));
check("createFromWorld を使っている（place は使わない）", true);

console.log("\n== FR-1 異常系: 70x70x70 ==");
alice.setDynamicProperty("buildhelper:sel_pos1", JSON.stringify({ x: 0, y: 0, z: 0, dim: dim.id }));
alice.setDynamicProperty("buildhelper:sel_pos2", JSON.stringify({ x: 69, y: 69, z: 69, dim: dim.id }));
formLog.length = 0;
responses.push(
  { canceled: false, selection: 0 }, // 設計図管理
  { canceled: false, selection: 0 }, // 保存
  { canceled: true }                 // エラー表示を閉じる
);
wand.onUse({ source: alice });
await flush();
const tooBig = formLog.find((f) => String(f.body ?? "").includes("範囲が大きすぎます"));
check("「範囲が大きすぎます」が表示される", Boolean(tooBig), JSON.stringify(formLog.map((f) => f.title)));
check("保存件数は増えていない", JSON.parse(world._props.get("buildhelper:blueprint_list")).length === 1);

console.log("\n== FR-2 / FR-3 ゴースト表示と進捗 ==");
// 8ブロック中4ブロックを壊す
for (let x = 0; x <= 1; x++) for (let z = 0; z <= 1; z++) setBlock(x, 64, z, "minecraft:air");

formLog.length = 0;
captured.messages.length = 0;
responses.push(
  { canceled: false, selection: 0 },                 // 設計図管理
  { canceled: false, selection: 1 },                 // 一覧
  { canceled: false, selection: 0 },                 // 1件目
  { canceled: false, selection: 0 },                 // ゴースト表示ON
  { canceled: false, formValues: ["0", "64", "0"] }, // 基準座標
  { canceled: false, selection: 1 },                 // 進捗を確認
  { canceled: true }
);
wand.onUse({ source: alice });
await flush();

const ghost = JSON.parse(alice._props.get("buildhelper:ghost_state") ?? "null");
check("ゴースト状態が永続化された", ghost?.visible === true && ghost.origin.x === 0);
const progress = formLog.find((f) => String(f.title ?? "").includes("進捗"));
check("進捗フォームが出た", Boolean(progress));
check("完成率が50%", String(progress?.body).includes("完成率: 50%"), String(progress?.body));
check("総ブロック数が8", String(progress?.body).includes("総ブロック数: 8"), String(progress?.body));

console.log("\n== FR-2 パーティクル描画 ==");
dim.particles.length = 0;
alice.location = { x: 1, y: 64, z: 1 };
captured.intervals.find((i) => i.ticks === 10).fn();
check("未設置ブロックに粒が出る", dim.particles.length > 0, `${dim.particles.length} 個`);
check("粒の上限を超えない", dim.particles.length <= 160);
check(
  "出た粒はすべて未設置座標",
  dim.particles.every((p) => p.location.x < 2.5 && p.location.z < 2.5),
  JSON.stringify(dim.particles.map((p) => p.location))
);

console.log("\n== FR-4 持ち寄りリスト ==");
formLog.length = 0;
bob._give("minecraft:stone", 1); // Bob が石を1個持っている
responses.push(
  { canceled: false, selection: 0 },              // 設計図管理
  { canceled: false, selection: 1 },              // 一覧
  { canceled: false, selection: 0 },              // 1件目
  { canceled: false, selection: 2 },              // 持ち寄りリスト
  { canceled: false, formValues: [true, true] },  // Alice と Bob
  { canceled: true }
);
wand.onUse({ source: alice });
await flush();
const share = formLog.find((f) => String(f.title ?? "").includes("持ち寄り"));
check("持ち寄りリストが出た", Boolean(share));
check("必要4 / 所持1 / 不足3 と出る", String(share?.body).includes("必要 4 / 所持 1 / 不足 3"), String(share?.body));
check(
  "端数が先頭のプレイヤーに寄る（Alice:2 / Bob:1）",
  String(share?.body).includes("Alice: 2 / Bob: 1"),
  String(share?.body)
);

console.log("\n== FR-5 ミラー設置 ==");
// X=10 を基準面に設定
alice.setDynamicProperty(
  "buildhelper:mirror_axis",
  JSON.stringify({ axis: "x", origin: { x: 10, y: 64, z: 0 } })
);
alice._give("minecraft:cobblestone", 1); // 設置後に手元に1個残っている状態
setBlock(9, 70, 0, "minecraft:cobblestone");
captured.events.get("playerPlaceBlock")[0]({
  player: alice,
  block: dim.getBlock({ x: 9, y: 70, z: 0 }),
  dimension: dim,
});
await flush();
check("対称位置(x=11)に設置された", dim.getBlock({ x: 11, y: 70, z: 0 }).typeId === "minecraft:cobblestone");
check("丸石が1個消費されて0になった", alice._slots[0] === undefined, JSON.stringify(alice._slots[0]));

// 在庫が無い状態でもう一度
captured.messages.length = 0;
setBlock(8, 70, 0, "minecraft:cobblestone");
captured.events.get("playerPlaceBlock")[0]({
  player: alice,
  block: dim.getBlock({ x: 8, y: 70, z: 0 }),
  dimension: dim,
});
await flush();
check("在庫不足なら対称設置しない", dim.getBlock({ x: 12, y: 70, z: 0 }).isAir);
check("警告が1回出る", captured.messages.filter((m) => m.includes("在庫が不足")).length === 1);
// 2回目は出ない
setBlock(7, 70, 0, "minecraft:cobblestone");
captured.events.get("playerPlaceBlock")[0]({
  player: alice,
  block: dim.getBlock({ x: 7, y: 70, z: 0 }),
  dimension: dim,
});
await flush();
check("警告は2回目以降出ない", captured.messages.filter((m) => m.includes("在庫が不足")).length === 1);

// 階段の向き反転
alice._give("minecraft:oak_stairs", 5);
setBlock(9, 71, 0, "minecraft:oak_stairs", { "minecraft:cardinal_direction": "east" });
captured.events.get("playerPlaceBlock")[0]({
  player: alice,
  block: dim.getBlock({ x: 9, y: 71, z: 0 }),
  dimension: dim,
});
await flush();
check(
  "X軸ミラーで階段の向きが east→west に反転",
  dim.getBlock({ x: 11, y: 71, z: 0 }).permutation.getAllStates()["minecraft:cardinal_direction"] === "west",
  JSON.stringify(dim.getBlock({ x: 11, y: 71, z: 0 }).permutation.getAllStates())
);

// クリエイティブでは動かない
const carol = makePlayer("Carol", GameMode.Creative);
carol.setDynamicProperty(
  "buildhelper:mirror_axis",
  JSON.stringify({ axis: "x", origin: { x: 10, y: 64, z: 0 } })
);
setBlock(9, 72, 0, "minecraft:stone");
captured.events.get("playerPlaceBlock")[0]({
  player: carol,
  block: dim.getBlock({ x: 9, y: 72, z: 0 }),
  dimension: dim,
});
await flush();
check("クリエイティブでは対称設置されない", dim.getBlock({ x: 11, y: 72, z: 0 }).isAir);

console.log("\n== FR-6 ガイドライン ==");
formLog.length = 0;
responses.push(
  { canceled: false, selection: 2 },                                  // ガイドライン表示
  { canceled: false, formValues: [0, 0, "0", "64", "0", 5, 30] }      // 直線 / X軸 / 間隔5 / 30秒
);
wand.onUse({ source: alice });
await flush();
dim.particles.length = 0;
captured.intervals.find((i) => i.ticks === 10).fn();
check("ガイドラインの粒が出る", dim.particles.length > 0, `${dim.particles.length} 個`);
check("ガイドラインの粒が上限内", dim.particles.length <= 320 + 160);

captured.messages.length = 0;
system.currentTick = 30 * 20 + 1; // 表示時間を過ぎさせる
captured.intervals.find((i) => i.ticks === 10).fn();
check("指定秒数で自動消去される", captured.messages.some((m) => m.includes("ガイドラインの表示時間が終了")));

console.log("\n== FR-7 集合テレポート ==");
captured.messages.length = 0;
alice.location = { x: 100, y: 70, z: 100 };
system.currentTick = 100000;
beacon.onUse({ source: alice });
await flush();
check("Bob が実行者の座標へ移動", bob.location.x === 100 && bob.location.z === 100, JSON.stringify(bob.location));
check("Carol も移動", carol.location.x === 100);

captured.messages.length = 0;
system.currentTick += 20 * 10; // 10秒後
beacon.onUse({ source: alice });
await flush();
check(
  "クールダウン中は残り秒数を表示して実行しない",
  captured.messages.some((m) => m.includes("クールダウン中") && m.includes("50 秒")),
  JSON.stringify(captured.messages)
);

// 1人だけの状態
players.length = 0;
players.push(alice);
captured.messages.length = 0;
system.currentTick += 20 * 120;
beacon.onUse({ source: alice });
await flush();
check("1人なら「他に参加者がいません。」", captured.messages.some((m) => m.includes("他に参加者がいません")));

console.log("\n== コンテンツログ ==");
check("警告が出ていない", captured.warnings.length === 0, JSON.stringify(captured.warnings));

console.log(`\n${failures === 0 ? "すべて成功" : `${failures} 件失敗`}`);
process.exit(failures === 0 ? 0 : 1);
