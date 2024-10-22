# basics-language-server

Features:

* **Buffer completion** - complete words that are already in the buffer
* **Path completion** - complete file paths relative from buffer or absolute
* **Snippet completion** - complete custom snippets or from packages (like [friendly-snippets](https://github.com/rafamadriz/friendly-snippets))

To install:

```bash
npm install -g basics-language-server
```

## Usage with neovim

The server is available in [`nvim-lspconfig`](https://github.com/neovim/nvim-lspconfig). Start the server with 

```lua
require('lspconfig').basics_ls.setup({})
```

## Settings

```lua
require('lspconfig').basics_ls.setup({
    settings = {
        buffer = {
            enable = true,
            minCompletionLength = 4 -- only provide completions for words longer than 4 characters
            matchStrategy: 'exact', -- or 'fuzzy'
        },
        path = {
            enable = true,
        },
        snippet = {
            enable = false,
            sources = {} -- paths to package containing snippets, see examples below
            matchStrategy: 'exact', -- or 'fuzzy'
        },
    }
})
```

### Settings snippet sources

`snippet.sources` can be a string or a list of strings. The strings should be absolute paths (or globs that resolve to paths) to one of either:
- Directory containing snippets. Example: `'/home/user/snippets'` which contains `python.json`
- Directory containing `package.json` that defines per language snippets in a [VS Code extension API format](https://code.visualstudio.com/api/references/contribution-points#contributes.snippets).
- Path to `package.json` that defines per language snippets in a [VS Code extension API format](https://code.visualstudio.com/api/references/contribution-points#contributes.snippets).
- A json or jsonc file where its name is the language id and its content is snippets. Example: `'/home/user/snippets/python.json'`. See [VS Code example](https://code.visualstudio.com/docs/editor/userdefinedsnippets#_create-your-own-snippets) for format
