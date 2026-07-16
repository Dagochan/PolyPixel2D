# .pptd フォーマット仕様（テクスチャペイント姉妹アプリ向け）

> このドキュメントは、PolyPixel2Dの `.pptd` プロジェクトファイルを**読み込んで(できれば書き戻して)使う外部アプリ**（テクスチャペイント姉妹アプリなど）のために、必要なデータ契約だけを抜き出したもの。
> PolyPixel2D本体のリグ・アニメーション・モディファイア関連のフィールドは意図的に「無視してよい」として記載している——姉妹アプリはそれらを読む必要はない（読んでも解釈できなくてよい、書き戻すときは元の値をそのまま保持すればよい）。
>
> **正本はコードの方**。このドキュメントは`PROJECT_VERSION`が上がった時、または以下で参照しているファイルが変更された時に更新すること。参照元:
> - `src/scene/project.ts`（ファイル全体の構造・保存/読み込み）
> - `src/scene/types.ts`（`Mesh`/`SceneObject`/`Material`/`UvIslandTransform`）
> - `src/scene/uv.ts`（アイランド検出・UV座標の計算アルゴリズム）
>
> 最終更新: 2026-07-13（`PROJECT_VERSION = 2` 時点）

## 1. ファイル全体の構造

`.pptd`は素のJSON（`JSON.stringify`されたもの、整形なし）。トップレベルの形:

```ts
interface ProjectFile {
  version: number           // 現在 2。姉妹アプリは version の互換範囲をチェックすること
  objects: SceneObject[]    // シーン内の全オブジェクト（フラットな配列、親子関係は各オブジェクトの parentId で表現）
  referenceImage: ReferenceImage | null  // 下絵。ペイント用途では無視してよい
  meshOpacity: number        // ビューポート表示設定。無視してよい
  clips: AnimationClip[]     // アニメーションクリップ。ペイント用途では無視・そのまま保持
  pixelFrame: PixelFrame | null  // Pixel Preview用の固定フレーム設定。無視してよい
}
```

- `version`未満のフィールド欠如（`clips`, `pixelFrame`）は本体側の`parseProjectFile`が読み込み時に補完している。姉妹アプリが自前でパースする場合も同様のフォールバックを入れること（`clips: []`, `pixelFrame: null`）。
- **書き戻す場合の注意**: `objects`以外のフィールド（`referenceImage`/`meshOpacity`/`clips`/`pixelFrame`）は姉妹アプリが理解しない内容を含むので、**読み込んだ値をそのまま保持して書き戻す**こと（構造を保ったまま、ペイントで変更したオブジェクトの`material`/`faceColors`/`uvIslandTransforms`等だけ更新する）。

## 2. `SceneObject` — ペイントに関係あるフィールドだけ抜粋

```ts
interface SceneObject {
  id: string
  name: string
  kind?: 'mesh' | 'empty' | 'path' | 'lattice'  // ペイント対象は 'mesh'（省略時のデフォルト）のみ。他種別はスキップしてよい
  mesh: Mesh
  material: Material
  uvIslandTransforms?: UvIslandTransform[]   // アイランドごとのUV配置（後述）
  uvBaseVertices?: Record<number, Vec2>      // UV展開の基準になる「休息姿勢」の頂点位置（後述）
  islandZOrders?: Record<number, number>     // アイランドの描画順（低いほど奥）
  islandNames?: Record<number, string>       // アイランドのユーザー命名
  islandVisible?: Record<number, boolean>    // アイランドの可視/不可視
  islandLocked?: Record<number, boolean>     // アイランドの編集ロック（ペイントには影響しない見た目上の情報）
  zOrder: number  // シーン内でのオブジェクト描画順（下絵/合成プレビューを作るなら必要、単体アイランドの塗りには不要）
  visible: boolean
  // 以下は無視してよい（リグ・アニメーション関連）:
  // transform, tail, parentId, connected, latticeCols/Rows, closed, cageRestVertices,
  // slotName, insertSlots, shapeKeys, shapeKeyValues, modifiers, showIslandNames
}
```

### `Mesh`

```ts
interface Vec2 { x: number; y: number }

interface Mesh {
  vertices: Vec2[]
  faces: number[][]  // 各面は頂点インデックスの順序付きリスト（CCW）。三角形/四角形/Ngon混在可
  faceColors?: Record<number, string>  // 面ごとの色上書き（16進カラー文字列）、`faces`のインデックスに対応。無いキーは material.color にフォールバック
}
```

### `Material`

```ts
interface Material {
  color: string          // ベースカラー（16進）
  textureUrl?: string    // インポートしたテクスチャ画像の Data URL。color と乗算合成される
}
```

姉妹アプリがペイントで生成したテクスチャは、この`textureUrl`にData URLとして書き戻す想定（本体側のテクスチャインポートと同じ形）。

## 3. UV座標の求め方（最重要）

`.pptd`には最終的なUV座標（0..1）は**保存されていない**。保存されているのは「アイランド検出のもとになるメッシュ」と「アイランドごとの手動配置(`uvIslandTransforms`)」だけで、最終UVは**都度計算**する。アルゴリズムは`src/scene/uv.ts`の`computeSplitUVs`/`computeSplitUVIslands`が正本。手順は以下:

### 3.1 アイランド検出 (`findIslands`)

`mesh.faces`を「フルエッジ（2頂点とも）を共有する面同士は同じアイランド」というルールで連結成分に分割する。同じオブジェクト内で物理的に繋がっていない部位（例: 別々に作って結合したメッシュ）はそれぞれ別アイランドになる。

```ts
interface Island {
  faces: number[]     // このアイランドに属する面のインデックス（mesh.faces基準）
  vertices: number[]  // このアイランドに属する頂点のインデックス（mesh.vertices基準）
}
```

`findIslands(mesh)`の返す配列の**順序**が、`uvIslandTransforms`/`islandZOrders`/`islandNames`/`islandVisible`/`islandLocked`の**インデックスの基準**になる。つまりこれらのフィールドは「アイランドの内容」ではなく「アイランドの順序（インデックス）」に紐付いている。**メッシュのトポロジーが変わるとインデックスがズレる**ため、本体側でもこれは既知の制約として扱われている（コメント: 「only meaningful as long as the mesh's islands haven't changed」）。

### 3.2 アイランドごとのベースUV (`islandBaseUV`)

各アイランドについて、頂点位置（`uvBaseVertices[i]`があればそれを、無ければ`mesh.vertices[i]`をそのまま）のバウンディングボックスを求め、**長い方の辺**で両軸を割って0..1に正規化する（アスペクト比を保ったまま、長辺が0..1いっぱいになる）。

```
size = max(bboxWidth, bboxHeight) || 1
baseUV(v) = ((v.x - minX) / size, (v.y - minY) / size)
```

### 3.3 手動配置の適用 (`applyIslandTransform`)

```ts
interface UvIslandTransform {
  offsetX: number
  offsetY: number
  scale: number
  rotation: number  // ラジアン、アイランドのベースUVバウンディングボックス中心を軸に回転
  excludeFromDensityMatch?: boolean  // テクセル密度一致機能のフラグ。ペイントには無関係
}
```

`uvIslandTransforms[islandIdx]`があればそれを、無ければ`defaultIslandTransforms`が計算するグリッド配置（画像サイズに応じた自動並べ）を使う。ベースUV座標をアイランド中心周りに回転→スケール→オフセットの順で変換:

```
finalUV(baseUV) = (
  x: rotate(baseUV - center).x * scale + offsetX,
  y: rotate(baseUV - center).y * scale + offsetY,
)
```

### 3.4 まとめて計算したい場合

姉妹アプリで独自実装する代わりに、本体の`src/scene/uv.ts`から`computeSplitUVs(mesh, uvIslandTransforms, uvBaseVertices)`をそのまま呼べば `{ mesh, uvs }`（UV展開済みの複製メッシュ＋頂点ごとのUV座標配列）が手に入る。**この関数をコピーして使うのが一番安全**（アルゴリズムの正本は常にこのファイル）。

## 4. ペイント対象の特定（アウトライナー構造）

姉妹アプリの塗り分けUIは基本的に「オブジェクト→アイランド」の2階層で十分:

1. `objects`を`kind`が`undefined`または`'mesh'`のものだけフィルタ
2. 各オブジェクトについて`findIslands(mesh)`でアイランド一覧を取得
3. `islandNames[idx]`があれば表示名に使う（無ければ「アイランド N」）
4. `islandVisible[idx] === false`のアイランドは非表示として扱う（塗り自体はできてよいが、プレビューでは隠す）

## 5. 書き戻し時の互換性チェックリスト

- [ ] `version`フィールドは変更しない（姉妹アプリが対応する`PROJECT_VERSION`と一致することだけ確認）
- [ ] `objects`配列の**要素数・順序・`id`**は変更しない（他の参照——`parentId`, `slotName`/`insertSlots`, `AnimationClip`のトラック——が`id`ベースなので、IDを変えると壊れる）
- [ ] `mesh.vertices`/`mesh.faces`のトポロジーを変更しない（ペイントは`material.color`/`material.textureUrl`/`mesh.faceColors`/`uvIslandTransforms`の更新のみに留める。頂点を動かす・面を増減するのは本体側のモデリング機能の役割）
- [ ] 理解できないフィールド（`transform`, `shapeKeys`, `modifiers`, `clips`の中身 等）は読み込んだ値をそのまま保持する（削除・null化しない）
