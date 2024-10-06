/**
 * TODO
 * - [x] completion for identifiers in current document
 * - [x] completion for paths from current document
 * - [x] completion for paths from root
 * - [x] completion for paths from ~
 * - [x] workspace configuration
 * - [ ] completion for snippets
 *   - [x] load from package.json
 *   - [ ] validate json
 *   - [ ] load from lang.json
 *   - [ ] load from dir
 *   - [ ] validate json
 *   - [ ] support JSONC
 *   - [ ] support globs for snippet sources
 *   - [ ] disable/enable
 *   - [ ] cache loaded snippets
 *   - [ ] optimise completion by snippets
 */
import * as lsp from 'vscode-languageserver/node';
import {textDocuments} from './textDocuments.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

import * as uri from 'vscode-uri';

interface UserSettings {
  buffer: {
    enable: boolean,
    minCompletionLength: number,
  },
  path: {
    enable: boolean,
  },
  snippet: {
    enable: boolean,
    sources: string | string[],
  }
}

const SETTINGS: UserSettings = {
  buffer: {
    enable: true,
    /** only complete identifiers longer than this */
    minCompletionLength: 4,
  },
  path: {
    enable: true
  },
  snippet: {
    enable: false,
    /**
     * Path or glob to dir containing package.json with VS Code style defined snippets
     * @example "~/.config/path/to/friendly-snippets"
     * @see (https://github.com/rafamadriz/friendly-snippets)
     *
     * Path or glob to json/jsonc file
     * @example "~/.config/snippepts/*"
     * @example "~/.config/snippepts/javascript.json"
     *
     * On how to define snippets see:
     * @see https://code.visualstudio.com/docs/editor/userdefinedsnippets#_create-your-own-snippets
     */
    sources: '~/.config/friendly-snippets' as string | string[],
  }
};

const RE = {
  // This regex makes a **smaaaaall assumption** that path parts
  // are always composed of letters, digits, hyphens, and underscores
  // and paths parts are separated by slashes (unix like)
  path: /(~|\.{1,2})?(\/([\w\d-_\.]*|\.{1,2}))*\/$/,
}

interface BasicsSnippetDefintion {
  label: string;
  prefix: string | string[];
  body: string | string[];
  description?: string; // fallbacks to name
}

interface VSCodeSnippetEntity {
  prefix: string | string[];
  body: string | string[];
  description?: string; // fallbacks to name
}
interface VSCodeSnippetsDefinition {
  [name: string]: VSCodeSnippetEntity;
}

class SnippetCache {
  globalSnippets: BasicsSnippetDefintion[] = [];
  snippetsByLanguage: {[lang: string]: BasicsSnippetDefintion[]} = {};

  /* for pakcage.json vscode like snippets */
  loadSnippetsFromPackageJson(absolutePath: string) {
    // TODO validate json
    // TODO support JSONC
    // TODO lift validation and errors to onConfigurationChange
    const pkgJson = JSON.parse(fs.readFileSync(absolutePath, 'utf-8')) as unknown;
    // @ts-expect-error
    const snippets = pkgJson?.contributes?.snippets as Array<
      {language: string | string[], path: string}
    > | undefined;

    if (!snippets) {
      return;
    }

    const dir = path.dirname(absolutePath);

    for (const {language, path: relativeSnippetFilePath} of snippets) {
      const snippetsFilePath = path.join(dir, relativeSnippetFilePath);
      if (typeof language === 'string') {
        this.loadSnippetsFromLanguageJson(snippetsFilePath, language);
      } else {
        for (const lang of language) {
          this.loadSnippetsFromLanguageJson(snippetsFilePath, lang);
        }
      }
    }
  }
  loadSnippetsFromLanguageJson(absolutePath: string, lang?: string) {
    // TODO avoid multiple file reads
    // TODO validate json
    // TODO support JSONC
    // TODO lift validation and errors to onConfigurationChange
    const json = JSON.parse(fs.readFileSync(absolutePath, 'utf-8')) as VSCodeSnippetsDefinition;
    if (lang == null) {
      lang = path.basename(absolutePath, '.json');
    }

    this.addSnippets(lang, Object.entries(json));
  }

  addSnippets(lang: string, snippets: Array<[name: string, entity: VSCodeSnippetEntity]>) {
    const target = lang === 'global' ? this.globalSnippets : (this.snippetsByLanguage[lang] ??= []);

    for (const [name, snippet] of snippets) {
      target.push({
        label: name,
        prefix: snippet.prefix,
        body: snippet.body,
        description: snippet.description,
      });
    }
  }

  getCompletionItems(
    languageId: string,
    linePreCursor: string,
    _connection: lsp.Connection,
  ): lsp.CompletionItem[] {
    const completionItems: lsp.CompletionItem[] = [];

    const match = linePreCursor.match(/\b[A-Za-z_$][A-Za-z0-9_$]*$/);
    if (!match) {
      return completionItems;
    }

    const typedWord = match[0];

    for (const snippet of this.globalSnippets) {
      if (isSnippetMatch(snippet, typedWord)) {
        completionItems.push(cachedSnippetToCompletionItem(snippet));
      }
    }

    if (languageId in this.snippetsByLanguage) {
      for (const snippet of this.snippetsByLanguage[languageId]) {
        if (isSnippetMatch(snippet, typedWord)) {
          completionItems.push(cachedSnippetToCompletionItem(snippet));
        }
      }
    }

    return completionItems;
  }
}
function isSnippetMatch(snippet: BasicsSnippetDefintion, typedText: string): boolean {
  if (Array.isArray(snippet.prefix)) {
    return snippet.prefix.some(prefix => prefix.startsWith(typedText));
  }
  return snippet.prefix.startsWith(typedText);
}
function cachedSnippetToCompletionItem(snippet: BasicsSnippetDefintion): lsp.CompletionItem {
  return {
    label: snippet.description ?? snippet.label,
    insertText: Array.isArray(snippet.body) ? snippet.body.join('\n') : snippet.body,
    kind: lsp.CompletionItemKind.Snippet,
  } satisfies lsp.CompletionItem;
}

export function createConnection(): lsp.Connection {
  const connection = lsp.createConnection(process.stdin, process.stdout);
  const snippetCache = new SnippetCache();

  textDocuments.listen(connection);

  connection.onCompletion((params, _token) => {
    if (!(SETTINGS.buffer.enable || SETTINGS.path.enable || SETTINGS.snippet.enable)) {
      return null;
    }
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
    const {languageId} = textDocument;
    const lineTextPreCursor = textDocument.getText(
      {
        start: {line: params.position.line, character: 0},
        end: params.position,
      } satisfies lsp.Range,
    );

    if (SETTINGS.path.enable && lineTextPreCursor.endsWith('/')) {
      return getPathsCompletionItems(
        lineTextPreCursor,
        params.textDocument.uri,
        connection,
      );
    }

    // user started typing a word
    const match = lineTextPreCursor.match(/\b[A-Za-z_$][A-Za-z0-9_$]*$/);
    if (!match) {
      return [];
    }

    const typedWord = match[0];

    const snippetCompletions: lsp.CompletionItem[] =
      SETTINGS.snippet.enable
        ? snippetCache.getCompletionItems(languageId, typedWord, connection)
        : [];

    if (!SETTINGS.buffer.enable) {
      return snippetCompletions;
    }

    const bufContent = textDocument.getText();
    const allIdentifiers = bufContent.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g);

    if (!allIdentifiers) return snippetCompletions;

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

    return [...bufCompletions, ...snippetCompletions];
  });

  // TODO debounce doc updates to save cache identifiersLike used for completion
  // textDocuments.onDidChangeContent(change => {});

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

  connection.onDidChangeConfiguration(change => {
    // TODO validate new settings
    if (change.settings.buffer) {
      Object.assign(SETTINGS.buffer, change.settings.buffer);
    }
    if (change.settings.path) {
      Object.assign(SETTINGS.path, change.settings.path);
    }
    if (change.settings.snippet) {
      Object.assign(SETTINGS.snippet, change.settings.snippet);

      if (SETTINGS.snippet.enable && SETTINGS.snippet.sources) {
        const sources = typeof SETTINGS.snippet.sources === 'string' ? [SETTINGS.snippet.sources] : SETTINGS.snippet.sources;

        // TODO support globs
        for (const sourcePath of sources) {
          try {
            const normalizedPath = path.normalize(sourcePath);
            const baseName = path.basename(normalizedPath);
            if (baseName === 'package.json') {
              snippetCache.loadSnippetsFromPackageJson(sourcePath);
            } else {
              snippetCache.loadSnippetsFromLanguageJson(sourcePath);
            }
          } catch (e: any) {
            connection.console.error(`Failed to load snippets from ${sourcePath}. Error: ${e?.message ?? e}`);
          }
        }
      }
    }
  });

  return connection;
}

function getPathsCompletionItems(
  linePreCursor: string,
  documentUri: lsp.DocumentUri,
  _connection: lsp.Connection,
): lsp.CompletionItem[] {
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
