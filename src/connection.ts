import * as lsp from 'vscode-languageserver/node';
import fg from 'fast-glob';
import {textDocuments} from './textDocuments.js';
import * as JSONC from 'jsonc-parser';
import * as S from 'superstruct';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {isBinaryFile} from 'isbinaryfile';

import * as uri from 'vscode-uri';

const PackageJsonSnippetsSchema = S.array(
  S.type({
    language: S.union([S.string(), S.array(S.string())]),
    path: S.string(),
  })
);

const VSCodeSnippetEntitySchema = S.type({
  prefix: S.union([S.string(), S.array(S.string())]),
  body: S.union([S.string(), S.array(S.string())]),
  // Arrays are not valid descriptions but there are cases where arrays are using in descriptoin
  description: S.optional(S.union([S.string(), S.array(S.string())])), // fallbacks to name
});
type VSCodeSnippetEntity = S.Infer<typeof VSCodeSnippetEntitySchema>;
const VSCodeJsonSnippetsDefinitionSchema = S.record(S.string(), VSCodeSnippetEntitySchema);
type VSCodeJsonSnippetsDefinition = S.Infer<typeof VSCodeJsonSnippetsDefinitionSchema>;

const MatchStrategySchema = S.enums(['exact', 'fuzzy']);
type MatchStrategy = S.Infer<typeof MatchStrategySchema>;
const BufferSettingsSchema = S.object({
  enable: S.boolean(),
  matchStrategy: MatchStrategySchema,
  minCompletionLength: S.number(),
});
const PathSettingsSchema = S.object({
  enable: S.boolean(),
});
const SnippetSettingsSchema = S.object({
  enable: S.boolean(),
  sources: S.union([S.string(), S.array(S.string())]),
  matchStrategy: MatchStrategySchema,
});
const SettingsSchema = S.object({
  buffer: BufferSettingsSchema,
  path: PathSettingsSchema,
  snippet: SnippetSettingsSchema,
});

// just like above but everything is options
const UserSettingsSchema = S.partial(S.object({
  buffer: S.partial(BufferSettingsSchema),
  path: S.partial(PathSettingsSchema),
  snippet: S.partial(SnippetSettingsSchema),
}));

const SETTINGS: S.Infer<typeof SettingsSchema> = {
  buffer: {
    enable: true,
    /** only complete identifiers longer than this */
    minCompletionLength: 4,
    matchStrategy: 'exact',
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
    sources: [] as string | string[],
    matchStrategy: 'exact',
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

type Result<Ok, Err> = {
  ok: true;
  value: Ok;
} | {
  ok: false;
  error: Err
}

const createMatcher: Record<MatchStrategy, (typedText: string) => (prefix: string) => boolean> = {
  exact: (typedText) => (prefix) => prefix.startsWith(typedText),
  fuzzy: (typedText) => {
    // has to start with the first character
    // but there can be more characters between the typed ones
    const re = new RegExp(`^${typedText.split('').join('.*')}`)

    return (prefix) => re.test(prefix);
  },
};
export class SnippetCache {
  globalSnippets: BasicsSnippetDefintion[] = [];
  snippetsByLanguage: {[lang: string]: BasicsSnippetDefintion[]} = {};

  private fileCache: Map<string, VSCodeJsonSnippetsDefinition> = new Map();
  clearFileCache() {
    this.fileCache.clear();
  }

  readJsonSnippetsFile(absolutePath: string): Result<VSCodeJsonSnippetsDefinition, string> {
    if (this.fileCache.has(absolutePath)) {
      return {ok: true, value: this.fileCache.get(absolutePath)!};
    }

    const parseErrors: JSONC.ParseError[] = [];
    try {
      const json = JSONC.parse(
        fs.readFileSync(absolutePath, 'utf-8'),
        parseErrors,
      );
      S.assert(json, VSCodeJsonSnippetsDefinitionSchema);

      this.fileCache.set(absolutePath, json);

      return {ok: true, value: json};
    } catch (error: any) {
      const msg = error?.message ?? String(error);
      return {ok: false, error: `Failed to parse ${absolutePath}. Error: ${msg}`};
    }
  }

  /**
   * For package.json vscode like snippets
   * only json is supported (no jsonc)
   */
  loadSnippetsFromPackageJson(absolutePath: string): Result<void, string> {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));

      const snippets = pkgJson?.contributes?.snippets as unknown;
      if (!snippets) {
        return {ok: true, value: undefined};
      }

      S.assert(snippets, PackageJsonSnippetsSchema);

      const dir = path.dirname(absolutePath);

      const errorMessages: string[] = [];
      for (const {language, path: relativeSnippetFilePath} of snippets) {
        const snippetsFilePath = path.join(dir, relativeSnippetFilePath);
        if (typeof language === 'string') {
          const out = this.loadSnippetsFromLanguageJson(snippetsFilePath, language);
          if (!out.ok) {
            errorMessages.push(out.error);
          }
        } else {
          for (const lang of language) {
            const out = this.loadSnippetsFromLanguageJson(snippetsFilePath, lang);
            if (!out.ok) {
              errorMessages.push(out.error);
            }
          }
        }
      }
      if (errorMessages.length > 0) {
        return {ok: false, error: errorMessages.join('\n')};
      }

      return {ok: true, value: undefined};
    } catch (e: any) {
      return {ok: false, error: `Failed to load snippets from ${absolutePath}. Error: ${e?.message ?? e}`};
    }
  }
  loadSnippetsFromLanguageJson(absolutePath: string, lang?: string): Result<void, string> {
    const jsonResult = this.readJsonSnippetsFile(absolutePath);

    if (!jsonResult.ok) {
      return jsonResult;
    }

    if (lang == null) {
      lang = path.basename(absolutePath, path.extname(absolutePath));
    }

    this.addSnippets(lang, Object.entries(jsonResult.value));

    return {ok: true, value: undefined};
  }

  addSnippets(lang: string, snippets: Array<[name: string, entity: VSCodeSnippetEntity]>) {
    const target = lang === 'global' ? this.globalSnippets : (this.snippetsByLanguage[lang] ??= []);

    for (const [name, snippet] of snippets) {
      // combine name and prefixes, remove duplicates
      const triggers: string[] = Array.from(new Set(
        [
          name,
          ...Array.isArray(snippet.prefix) ? snippet.prefix : (snippet.prefix ? [snippet.prefix] : []),
        ]
      ));

      target.push({
        label: name,
        prefix: triggers,
        body: snippet.body,
        description: Array.isArray(snippet.description) ? snippet.description.join('') : snippet.description,
      });
    }
  }

  getCompletionItems(
    languageId: string,
    linePreCursor: string,
    matchStrategy: MatchStrategy,
  ): lsp.CompletionItem[] {
    const completionItems: lsp.CompletionItem[] = [];

    const match = linePreCursor.match(/\b[A-Za-z_$][A-Za-z0-9_$]*$/);
    if (!match) {
      return completionItems;
    }

    const typedWord = match[0];

    const matcher = createMatcher[matchStrategy](typedWord)

    for (const snippet of this.globalSnippets) {
      if (isSnippetMatch(snippet, matcher)) {
        completionItems.push(cachedSnippetToCompletionItem(snippet));
      }
    }

    if (languageId in this.snippetsByLanguage) {
      for (const snippet of this.snippetsByLanguage[languageId]) {
        if (isSnippetMatch(snippet, matcher)) {
          completionItems.push(cachedSnippetToCompletionItem(snippet));
        }
      }
    }

    return completionItems;
  }
}
function isSnippetMatch(snippet: BasicsSnippetDefintion, matcher: (prefix: string) => boolean): boolean {
  if (Array.isArray(snippet.prefix)) {
    return snippet.prefix.some(prefix => matcher(prefix));
  }
  return matcher(snippet.prefix);
}
function cachedSnippetToCompletionItem(snippet: BasicsSnippetDefintion): lsp.CompletionItem {
  return {
    label: snippet.description ?? snippet.label,
    insertText: Array.isArray(snippet.body) ? snippet.body.join('\n') : snippet.body,
    insertTextFormat: lsp.InsertTextFormat.Snippet,
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
        ? snippetCache.getCompletionItems(languageId, typedWord, SETTINGS.snippet.matchStrategy)
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

  connection.onCompletionResolve(async (item, token) => {
    if (!item.data?.absPath) {
      return item;
    }
    if (item.kind !== lsp.CompletionItemKind.File) {
      return item;
    }
    const stat = await fs.promises.stat(item.data.absPath);

    // display a stub if file is larger than 10MB
    if (stat.size > 10 * 1024 * 1024) {
      item.documentation = 'File is too large to preview';
      return item;
    }

    const data = await fs.promises.readFile(item.data.absPath);
    const isBin = await isBinaryFile(data, stat.size);

    if (isBin) {
      item.documentation = 'Binary file';
      return item;
    }

    if (token.isCancellationRequested) {
      return item;
    }

    const contents = data.toString();
    const ext = path.extname(item.label)
      // remove leading dot
      .slice(1);
    const markedString: lsp.MarkupContent = {
      kind: lsp.MarkupKind.Markdown,
      value: `\`\`\`${ext}\n${contents}\`\`\``,
    };
    item.documentation = markedString;

    return item;
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
    const settings = change.settings as unknown;

    try {
      S.assert(settings, UserSettingsSchema);

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

          const stack = [...sources];
          const errorMessages: string[] = [];

          while (stack.length > 0) {
            const sourcePath = stack.shift()!;

            if (fg.isDynamicPattern(sourcePath)) {
              const paths = fg.sync(sourcePath, {
                absolute: true,
                dot: true,
              });
              stack.unshift(...paths);
              continue;
            }
            try {
              const normalizedPath = path.normalize(sourcePath);

              // has package.json -> handle as package.json
              if (path.basename(normalizedPath) === 'package.json') {
                const out = snippetCache.loadSnippetsFromPackageJson(sourcePath);
                if (!out.ok) {
                  errorMessages.push(out.error);
                }
                continue;
              }

              // handle as language json file
              if (normalizedPath.endsWith('.json')) {
                const out = snippetCache.loadSnippetsFromLanguageJson(sourcePath);
                if (!out.ok) {
                  errorMessages.push(out.error);
                }

                continue;
              }

              // dir containing package.json or lang.json files
              if (fs.statSync(normalizedPath).isDirectory()) {
                const maybePackageJson = path.join(normalizedPath, 'package.json');
                if (fs.existsSync(maybePackageJson)) {
                  const out = snippetCache.loadSnippetsFromPackageJson(maybePackageJson);
                  if (!out.ok) {
                    errorMessages.push(out.error);
                  }
                } else {
                  // handle as <lang>.json files
                  const jsons = fg.sync('**/*.json', {
                    cwd: normalizedPath,
                    absolute: true,
                    dot: true,
                  });
                  for (const json of jsons) {
                    const out = snippetCache.loadSnippetsFromLanguageJson(json);
                    if (!out.ok) {
                      errorMessages.push(out.error);
                    }
                  }
                }
              }

              // else ignore
            } catch (e: any) {
              errorMessages.push(`Failed to load snippets from ${sourcePath}. Error: ${e?.message ?? e}`);
            }
          }

          // No need to keep file cache in memory after snippets are loaded
          snippetCache.clearFileCache();

          if (errorMessages.length > 0) {
            connection.console.warn(`Failed to load snippets. Error${errorMessages.length > 1 ? 's' : ''}: ${errorMessages.join('\n')}`);
          }
        }
      }
    } catch (e: any) {
      connection.console.error(`Failed to validate settings. Error: ${e?.message ?? e}`);
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

  return dirContents.map((dir) => {
    // TODO abort if token is cancelled
    let stat
    try {
      stat = fs.statSync(path.join(absolutePath, dir));
    } catch (e: any) {
      return null;
    }
    const isDir = stat.isDirectory();
    return {
      label: dir,
      kind: isDir ? lsp.CompletionItemKind.Folder : lsp.CompletionItemKind.File,
      data: {absPath: path.join(absolutePath, dir)},
    } satisfies lsp.CompletionItem;
  }).filter(x => x !== null);
}
