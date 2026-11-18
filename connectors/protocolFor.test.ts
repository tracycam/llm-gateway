// The protocol a connector picks for one request, from what its provider said the model speaks.
import { expect, test } from 'bun:test';
import { protocolFor } from './connector';

test('a model that speaks the client protocol uses it unchanged', () => {
  expect(protocolFor(['chat', 'messages'], 'messages', 'chat')).toBe('messages');
});

test('a model that does not speak the client protocol uses its first', () => {
  expect(protocolFor(['messages', 'chat'], 'responses', 'chat')).toBe('messages');
});

test('a provider that said nothing falls back to the connector default', () => {
  expect(protocolFor(null, 'responses', 'chat')).toBe('chat');
});

test('an empty list, which attempt answers before any connector, falls back', () => {
  expect(protocolFor([], 'chat', 'messages')).toBe('messages');
});
