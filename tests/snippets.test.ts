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
        ]
    ]);

    it('return completion item from snippet name', () => {
        const expectedCompItems = [
            {
                label: 'description',
                kind: 15,
                insertText: 'value',
                insertTextFormat: 2
            }
        ];

        expect(snippetCache.getCompletionItems('javascript', 'pref'))
            .toEqual(expectedCompItems);
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

        expect(snippetCache.getCompletionItems('javascript', 'na'))
            .toEqual(expectedCompItems);
    });
});
