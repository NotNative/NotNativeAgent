// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { validateProjectTodos } from '../project-context/todo-schema.ts';

describe('project context todo writes', () => {
  it('normalizes optional fields and preserves valid order', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123);
    expect(validateProjectTodos([{ id: 'one', text: 'First' }, { id: 'two', text: 'Second', completed: true, createdAt: 4 }]))
      .toEqual([{ id: 'one', text: 'First', completed: false, createdAt: 123 },
        { id: 'two', text: 'Second', completed: true, createdAt: 4 }]);
    vi.restoreAllMocks();
  });
  it.each([
    null, [{}], [{ id: '../bad', text: 'task' }], [{ id: 'one', text: '' }],
    [{ id: 'one', text: 'x'.repeat(121) }], [{ id: 'one', text: 'ok', completed: 'yes' }],
    [{ id: 'one', text: 'ok', createdAt: -1 }],
    [{ id: 'one', text: 'ok' }, { id: 'one', text: 'duplicate' }],
    Array.from({ length: 501 }, (_, index) => ({ id: `t${index}`, text: 'task' })),
  ])('rejects malformed lists without committing them', (value) => {
    expect(() => validateProjectTodos(value)).toThrow();
  });
});
