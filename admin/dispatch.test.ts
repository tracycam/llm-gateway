// Dispatch matching and refusal translation.
import { expect, test } from 'bun:test';
import { StoreRefusal } from '../schema';
import { dispatch, type AdminRoute } from './dispatch';
import { fixture, request } from './testing';
import { InputError } from './input';

test('rule 5: matching path with wrong method returns 405, foreign path returns null', async () => {
  const { deps, db } = fixture();
  const routes: AdminRoute[] = [['GET', /^\/api\/gateway\/x$/, () => new Response('ok')]];
  expect((await dispatch(request('/x', 'POST'), deps, routes))?.status).toBe(405);
  expect(await dispatch(request('/other'), deps, routes)).toBeNull();
  db.close();
});

for (const error of [new StoreRefusal('冲突', 409), new InputError('无效')]) {
  test(`rule 3: ${error.constructor.name} maps its status`, async () => {
    const { deps, db } = fixture();
    const routes: AdminRoute[] = [['GET', /^\/api\/gateway\/x$/, () => { throw error; }]];
    const response = await dispatch(request('/x'), deps, routes);
    expect(response?.status).toBe(error.status);
    expect(await response?.json()).toEqual({ error: error.message });
    db.close();
  });
}

test('rule 3: unexpected exceptions propagate', async () => {
  const { deps, db } = fixture();
  const routes: AdminRoute[] = [['GET', /^\/api\/gateway\/x$/, () => { throw new Error('bug'); }]];
  await expect(dispatch(request('/x'), deps, routes)).rejects.toThrow('bug');
  db.close();
});
