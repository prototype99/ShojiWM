---
sidebar_position: 4.5
---

# カーソルテーマ

`COMPOSITOR.cursor` は、デフォルトポインターやSSDのリサイズカーソルなど、
ShojiWMが所有するnamed cursorのXCursorテーマを設定します。

```ts
COMPOSITOR.cursor.configure({
  theme: 'Bibata-Modern-Classic',
  size: 24,
});
```

`theme` にはインストール済みXCursorテーマ名を指定します。`size` は1から512の
整数で、単位は**論理ピクセル**です。ShojiWMは出力ごとに適切にスケールされた画像を
選ぶため、24を指定したカーソルはscale 1とscale 2の出力で同じ論理サイズになります。

`configure()` はShojiWMを再起動せずに反映され、同時に次の処理を行います。

- 後から起動するプロセス向けに `XCURSOR_THEME` と `XCURSOR_SIZE` を設定する
- これらの変数をsystemdおよびD-Busのactivation environmentへ公開する
- ShojiWMがデコードしたカーソル画像とGPUバッファのキャッシュを破棄する
- 次の再描画から新しいnamed cursorを使用する

## テーマファイルの再読み込み

テーマ名やサイズを変えずにテーマファイルだけを置き換えた場合は、現在のテーマを
明示的に再読み込みできます。

```ts
COMPOSITOR.cursor.reload();
```

キーバインドから呼び出すこともできます。

```ts
COMPOSITOR.key.bind('reload-cursor', 'Super+Shift+C', () => {
  COMPOSITOR.cursor.reload();
});
```

## クライアント所有のカーソルサーフェス

Waylandクライアントは独自のカーソルサーフェスを送信できます。この場合、ShojiWMは
クライアントから渡されたサーフェスを表示する必要があり、named cursorへ強制的に
置き換えることはできません。

公開したXCursor環境変数により、新しく起動したツールキットは同じテーマを選択できます。
一方、すでに起動しているアプリケーションのクライアント所有カーソルを変更するには、
アプリケーションの再起動や、そのアプリケーション側での設定再読み込みが必要な場合があります。

カーソル設定を変更しても、クライアント所有のカーソルサーフェスは置換・加工されません。
