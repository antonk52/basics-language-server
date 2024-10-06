/**
 * TODO
 * - [x] completion for identifiers in current document
 * - [x] completion for paths from current document
 * - [x] completion for paths from root
 * - [x] completion for paths from ~
 * - [ ] workspace configuration
 * - [ ] completion for snippets
 */
import * as lsp from 'vscode-languageserver/node';
import {textDocuments} from './textDocuments.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

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

const RE = {
  // This regex makes a **smaaaaall assumption** that path parts
  // are always composed of letters, digits, hyphens, and underscores
  // and paths parts are separated by slashes (unix like)
  path: /(~|\.{1,2})?(\/([\w\d-_]|\.{1,2}))*\/$/,
}

export function createConnection(): lsp.Connection {
  const connection = lsp.createConnection(process.stdin, process.stdout);

  textDocuments.listen(connection);

  connection.onCompletion((params, _token) => {
    // TODO there are probably more optimal ways to
    // infer all identifier-like strings from the buffer
    // than getting full content and regexing it on every request
    if (params.position.character === 0) {
      return null;
    }
    const textDocument = textDocuments.get(params.textDocument.uri);
    if (!textDocument) {
      return null;
    }
    const lineTextPreCursor = textDocument.getText(
      {
        start: {line: params.position.line, character: 0},
        end: params.position,
      } satisfies lsp.Range,
    );

    if (lineTextPreCursor.endsWith('/')) {
      return getPathsCompletionItems(
        lineTextPreCursor,
        params.textDocument.uri,
        connection,
      );
    }

    const bufContent = textDocument.getText();
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

function getPathsCompletionItems(linePreCursor: string, documentUri: lsp.DocumentUri, _connection: lsp.Connection): lsp.CompletionItem[] {
  const match = linePreCursor.match(RE.path);

  if (!match) return [];

  const [pathLike] = match;

  let absolutePath = pathLike;
  if (pathLike.startsWith('~')) {
    const homeDir = process.env.HOME || os.homedir();
    absolutePath = path.join(homeDir, pathLike.slice(1));
  } else if (absolutePath.startsWith('.')) {
    const currentDir = uri.Utils.dirname(uri.URI.parse(documentUri));
    absolutePath = path.join(currentDir.fsPath, pathLike);
  }

  const dirContents = fs.readdirSync(absolutePath);

  // TODO async
  // TODO cache?
  return dirContents.map((dir) => {
    // TODO abort if token is cancelled
    // TODO async
    // TODO cache stats
    let stat
    try {
      stat = fs.statSync(path.join(absolutePath, dir));
    } catch (e: any) {
      return null;
    }
    return {
      label: dir,
      kind: stat.isDirectory() ? lsp.CompletionItemKind.Folder : lsp.CompletionItemKind.File,
      // TODO we can show first few lines of a file in `detail`
    } satisfies lsp.CompletionItem;
  }).filter(x => x !== null);
}
