import {describe, it, expect} from 'vitest';
import {SnippetCache} from '../src/connection';

describe('snippets', () => {
    const snippetCache = new SnippetCache();

    snippetCache.addSnippets('javascript', [
        [
            'name',
            {
                prefix: 'prefix-name',
                body: 'value',
                description: 'description'
            }
        ],
    ]);

    describe('match strategy exact', () => {
        it('return completion item from snippet name', () => {
            const expectedCompItems = [
                {
                    label: 'description',
                    kind: 15,
                    insertText: 'value',
                    insertTextFormat: 2
                }
            ];

            expect(snippetCache.getCompletionItems('javascript', 'pref', 'exact'))
                .toEqual(expectedCompItems);
        });
        it('does not return completion item from snippet name with missing characters', () => {
            expect(snippetCache.getCompletionItems('javascript', 'pex', 'exact'))
                .toEqual([]);
        });
        it('return completion item from snippet prefix', () => {
            const expectedCompItems = [
                {
                    label: 'description',
                    kind: 15,
                    insertText: 'value',
                    insertTextFormat: 2
                }
            ];

            expect(snippetCache.getCompletionItems('javascript', 'na', 'exact'))
                .toEqual(expectedCompItems);
        });
    });
    describe('match strategy fuzzy', () => {
        it('return completion item from snippet name like exact', () => {
            const expectedCompItems = [
                {
                    label: 'description',
                    kind: 15,
                    insertText: 'value',
                    insertTextFormat: 2
                }
            ];

            expect(snippetCache.getCompletionItems('javascript', 'pref', 'fuzzy'))
                .toEqual(expectedCompItems);
        });
        it('return completion item from snippet name with missing characters', () => {
            const expectedCompItems = [
                {
                    label: 'description',
                    kind: 15,
                    insertText: 'value',
                    insertTextFormat: 2
                }
            ];

            expect(snippetCache.getCompletionItems('javascript', 'pex', 'fuzzy'))
                .toEqual(expectedCompItems);
        });
        it('does not return completion item from snippet name with missing FIRST characters', () => {
            expect(snippetCache.getCompletionItems('javascript', 'refix', 'fuzzy'))
                .toEqual([]);
        });
        it('return completion item from snippet prefix', () => {
            const expectedCompItems = [
                {
                    label: 'description',
                    kind: 15,
                    insertText: 'value',
                    insertTextFormat: 2
                }
            ];

            expect(snippetCache.getCompletionItems('javascript', 'na', 'fuzzy'))
                .toEqual(expectedCompItems);
        });
    });
});
