# basics-language-server

To install:

```bash
npm install -g basics-language-server
```

## Usage with neovim

Until this is added to the LSP config, you can add it manually by adding this one file to your config:
```lua
-- lua/lspconfig/configs/basics_ls.lua
return {
    default_config = {
        cmd = { 'basics-language-server' },
        single_file_support = true
    },
    docs = {
        description = 'Buffer, path, and snippet completions',
        default_config = {
            buffer = {
                enable = true,
                minCompletionLength = 4
            },
            path = {
                enable = true,
            },
            snippet = {
                enable = false,
                sources = []
            }
        }
    }
}
```

Now you can start the server with `require('lspconfig').basics_ls.setup({})`

## Settings

```lua
require('lspconfig').basics_ls.setup({
    settings = {
        buffer = {
            enable = true,
            minCompletionLength = 4 -- only provide completions for words longer than 4 characters
        },
        path = {
            enable = true,
        },
        snippet = {
            enable = false,
            sources = [] -- paths to package containing snippets, see examples below
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
