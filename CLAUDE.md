# CLAUDE.md

PolyPixel2D — 2DポリゴンオブジェクトにHead/Tail（回転軸・接続点）ピボットを持たせて連結し、間接付きキャラを組んでアニメーションさせる2D DCCツール。最終目標はピクセライズ表示とスプライトシート書き出し。

- 元の依頼仕様: [PolyPixel2D.md](./PolyPixel2D.md)
- 実装状況とアーキテクチャ詳細: [PROGRESS.md](./PROGRESS.md) — 関連作業の前に必読。機能を追加したら更新する。

## 技術スタック

React + TypeScript + Vite / Three.js（OrthographicCameraの2Dビューポート）/ Zustand。
テストフレームワークは無し。検証は「型チェック + scratchpadスクリプト + previewでの実操作」で行う。

## コマンド・検証手順

- 開発サーバー: `preview_start` の `"dev"` 設定を使う（port 5183）。Bashで直接起動しない。
- 型チェック: `npx tsc --noEmit`（ビルドは `tsc -b && vite build`）
- ロジック単体の検証: scratchpadに検証スクリプト（.ts）を書いて `npx tsx` で実行する。

## アーキテクチャ要点

- `src/scene/types.ts` — Mesh / Transform / SceneObject（tail, parentId, connected, islandZOrders…）の型定義
- `src/scene/store.ts` — Zustandストア。全アクションとundo/redo履歴。**historyのスナップショットは objects と clips の両方を含む**。undo対象の操作は必ずここを経由する。
- `src/scene/transformUtils.ts` — 親子チェーンのローカル⇔ワールド変換
- `src/scene/composeDisplay.ts` — `composeDisplayObjects`: shape key / FFD / Path Deform / Follow Path / Fake Physics / Fake Flag 等を合成する共有変形パイプライン。**表示系は必ずこれを使う**（Viewport.tsx と PixelPreview.tsx は両方ともこの関数を呼ぶ。2026-07-10にViewport.tsx側の独自コピーは統合済み — 新しく描画系のコードを足す時にまた重複コピーを作らないこと）。
- `src/viewport/Viewport.tsx`（~4300行）— 描画と全ポインター/キーボード操作。`src/viewport/PixelPreview.tsx` — ピクセライズ表示（composeDisplayObjects使用、FakeBehindはステンシルバッファ）。
- `src/panels/` — Toolbar / ToolPane / Outliner / Properties / Timeline / UvEditor
- `src/scene/project.ts` — 保存/読み込み。**保存拡張子は .pptd**。

## 作業規約（必須）

- **ビューポートのパンは中ボタンドラッグのみ。** Alt+ドラッグのパンを追加しない（過去に削除済み）。
- **モーダル操作・配置待ちUIは Escape と右クリックの両方でキャンセル**できること。アプリ全体の規約。新しいモーダル操作を追加するときも必ず両対応する。**この規約はドラッグ操作全般に適用する**——将来、数値スライダーを独自コンポーネント化する際（現状は素の`<input type="range">`でこの規約の対象外）も、ドラッグ中の右クリックで元の値に戻せるようにする。
- UI・機能語彙はBlenderの英語用語に合わせる（G/R/S、Head/Tail、Extrude、Apply Scale など）。挙動の仕様が曖昧なときはBlenderの同名機能に合わせるのがデフォルト。
- トポロジーを変える操作（削除・マージ・ループカット・ナイフ等）では、頂点/辺/面に付随するデータ（creaseEdges, seamEdges, faceColors, shape keys, UV…）のremapを忘れない（`src/scene/remapVertexData.ts` 参照）。
- プレビューサーバーは検証後も**停止しない**。ユーザーが同じサーバーで並行してテストする。

## 完了条件（Definition of Done）

タスクは以下を満たすまで完了としない。途中でエラーが出たら自分で修正して続行する：

1. `npx tsc --noEmit` がエラーなしで通る。
2. previewで該当機能を実際に操作して動作確認し、スクリーンショット等の確認結果を示す。
3. 触った領域に応じて、関連する既存機能を壊していないか確認する。特に壊れやすいのは: undo/redo、shape key、Pixel Preview（メインビューポートと同じ変形結果になるか）、.pptd保存/読み込み。
4. 新機能・仕様変更なら PROGRESS.md を更新する。

## 進め方

- 可逆的な編集・検証はユーザー確認を待たずに進めてよい。破壊的な操作や仕様の大きな方針変更のみ確認する。
- ユーザーは実際にアプリを使い込んでバグを報告してくる。実使用からのバグ報告は最優先で扱う。
