/**
 * TODO
 * - [x] completion for identifiers in current document
 * - [x] completion for paths from current document
 * - [ ] workspace configuration
 * - [ ] completion for snippets
 */
import * as lsp from 'vscode-languageserver/node';
import {textDocuments} from './textDocuments.js';
import fs from 'fs';
import path from 'path';

import * as uri from 'vscode-uri';

const SETTINGS = {
  buffer: {
    enable: true,
    minCompletionLength: 4,
    triggerLength: 3
  },
  path: {
    enable: true
  }
}

export function createConnection(): lsp.Connection {
  const connection = lsp.createConnection(process.stdin, process.stdout);

  textDocuments.listen(connection);

  connection.onCompletion((params, _token) => {
    // TODO there are probably more optimal ways to
    // infer all identifier-like strings from the buffer
    // than getting full content and regexing it on every request
    const textDocument = textDocuments.get(params.textDocument.uri);
    if (!textDocument) {
      return null;
    }
    const bufContent = textDocument.getText();
    const lines = bufContent.split(getEOL(bufContent));
    const currentLine = lines[params.position.line];
    if (typeof currentLine !== 'string') return null;

    const linePreCursor = currentLine.slice(0, params.position.character);

    if (currentLine.endsWith('/')) {
      return getPathsCompletionItems(
        linePreCursor,
        params.textDocument.uri,
      );
    }

    const allIdentifiers = bufContent.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g);

    if (!allIdentifiers) return null;

    const bufCompletions = [...new Set(allIdentifiers)]
      .filter(x => x.length > SETTINGS.buffer.minCompletionLength)
      .map((identifierLike) => {
        return {
          label: identifierLike,
          insertTextMode: lsp.InsertTextMode.asIs,
          insertTextFormat: lsp.InsertTextFormat.PlainText,
          kind: lsp.CompletionItemKind.Text,
        } satisfies lsp.CompletionItem;
      });

    return bufCompletions;
  });

  // declare server capabilities
  connection.onInitialize(({capabilities}) => {
    const hasWorkspaceFolderCapability = !!(
      capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );
    const result: lsp.InitializeResult = {
      capabilities: {
        textDocumentSync: lsp.TextDocumentSyncKind.Incremental,
        completionProvider: {
          /** for paths completion */
          triggerCharacters: ['/'],
          resolveProvider: true,
        },
        workspace: {
          workspaceFolders: {
            supported: hasWorkspaceFolderCapability,
          }
        },
      },
    };

    return result;
  });


  return connection;
}

function getPathsCompletionItems(linePreCursor: string, documentUri: lsp.DocumentUri): lsp.CompletionItem[] {
  const match = linePreCursor.match(/\.?\.\/.*$/);

  if (!match) return [];

  const [pathLike] = match;

  const currentDir = uri.Utils.dirname(uri.URI.parse(documentUri));
  const absolutePath = path.join(currentDir.fsPath, pathLike);

  const dirContents = fs.readdirSync(absolutePath);

  // TODO async
  // TODO cache?
  return dirContents.map((dir) => {
    // TODO abort if token is cancelled
    // TODO async
    // TODO cache stats
    const stat = fs.statSync(path.join(absolutePath, dir));
    return {
      label: dir,
      kind: stat.isDirectory() ? lsp.CompletionItemKind.Folder : lsp.CompletionItemKind.File,
      // TODO we can show first few lines of a file in `detail`
    } satisfies lsp.CompletionItem;
  });
}

// People can have use EOL from other systems in their editor settings
// For this reason we need to infer EOL per document
// https://github.com/wkillerud/some-sass/blob/main/vscode-extension/src/utils/string.ts
function getEOL(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '\r') {
      if (i + 1 < text.length && text.charAt(i + 1) === '\n') {
        return '\r\n';
      }
      return '\r';
    }
    if (ch === '\n') {
      return '\n';
    }
  }
  return '\n';
}
