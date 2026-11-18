import { expect, test } from 'bun:test';
import { Abandoned, Admission, Notifier } from './admission';

const signal = () => new AbortController().signal;

/** One microtask runs the direct promise observers used to check whether a promise settled. */
async function settled(): Promise<void> {
  await Promise.resolve();
}

test('below the limit enter resolves at once and running counts it', async () => {
  const admission = new Admission();
  const place = admission.enter('a', 2, signal());
  expect(admission.running('a')).toBe(1);
  (await place)();
});

test('at the limit enter waits until a place is given back', async () => {
  const admission = new Admission();
  const release = await admission.enter('a', 1, signal());
  let granted = false;
  const next = admission.enter('a', 1, signal()).then((done) => { granted = true; return done; });
  await settled();
  expect(granted).toBe(false);
  expect(admission.waiting('a')).toBe(1);
  release();
  (await next)();
  expect(granted).toBe(true);
});

test('waiters are served first come, first served', async () => {
  const admission = new Admission();
  const release = await admission.enter('a', 1, signal());
  const order: number[] = [];
  const first = admission.enter('a', 1, signal()).then((done) => { order.push(1); return done; });
  const second = admission.enter('a', 1, signal()).then((done) => { order.push(2); return done; });
  release();
  await settled();
  expect(order).toEqual([1]);
  (await first)();
  (await second)();
  expect(order).toEqual([1, 2]);
});

test('a newcomer that would fit still waits behind earlier waiters', async () => {
  const admission = new Admission();
  const release = await admission.enter('a', 1, signal());
  const first = admission.enter('a', 1, signal());
  const newcomer = admission.enter('a', 5, signal());
  expect(admission.running('a')).toBe(1);
  expect(admission.waiting('a')).toBe(2);
  release();
  expect(admission.running('a')).toBe(2);
  (await first)();
  (await newcomer)();
});

test('ids are independent: a full id does not delay another', async () => {
  const admission = new Admission();
  const release = await admission.enter('a', 1, signal());
  const queued = admission.enter('a', 1, signal());
  const other = admission.enter('b', 1, signal());
  expect(admission.running('b')).toBe(1);
  (await other)();
  release();
  (await queued)();
});

test('limit null never waits', async () => {
  const admission = new Admission();
  const release = await admission.enter('a', 1, signal());
  const queued = admission.enter('a', 1, signal());
  const unlimited = admission.enter('a', null, signal());
  expect(admission.running('a')).toBe(2);
  (await unlimited)();
  release();
  (await queued)();
});

test('the head waiter limit governs admission after each release', async () => {
  const admission = new Admission();
  const releases = await Promise.all([1, 2, 3].map(() => admission.enter('a', 3, signal())));
  const low = admission.enter('a', 1, signal());
  const high = admission.enter('a', 3, signal());
  const high2 = admission.enter('a', 3, signal());
  releases[0]();
  releases[1]();
  expect(admission.waiting('a')).toBe(3);
  releases[2]();
  expect(admission.running('a')).toBe(3);
  expect(admission.waiting('a')).toBe(0);
  (await low)();
  (await high)();
  (await high2)();
});

test('the release function is idempotent', async () => {
  const admission = new Admission();
  const release = await admission.enter('a', 1, signal());
  const next = admission.enter('a', 1, signal());
  release();
  release();
  expect(admission.running('a')).toBe(1);
  (await next)();
  expect(admission.size()).toBe(0);
});

test('abandoning a waiter removes it and gives its place to the next waiter', async () => {
  const admission = new Admission();
  const release = await admission.enter('a', 1, signal());
  const controller = new AbortController();
  const abandoned = admission.enter('a', 1, controller.signal);
  const rejected = abandoned.catch((error: unknown) => error);
  const next = admission.enter('a', 1, signal());
  controller.abort();
  expect(await rejected).toBeInstanceOf(Abandoned);
  expect(admission.waiting('a')).toBe(1);
  release();
  expect(admission.running('a')).toBe(1);
  expect(admission.waiting('a')).toBe(0);
  (await next)();
});

test('abandoning the head waiter admits the next waiter when its limit allows', async () => {
  const admission = new Admission();
  const release = await admission.enter('a', 1, signal());
  const controller = new AbortController();
  const first = admission.enter('a', 1, controller.signal).catch((error: unknown) => error);
  const next = admission.enter('a', 2, signal());
  controller.abort();
  expect(await first).toBeInstanceOf(Abandoned);
  expect(admission.running('a')).toBe(2);
  expect(admission.waiting('a')).toBe(0);
  (await next)();
  release();
});

test('admission removes abort listeners on grant and abandonment', async () => {
  const admission = new Admission();
  const release = await admission.enter('a', 1, signal());
  const granted = new AbortController();
  const abandoned = new AbortController();
  let removed = 0;
  for (const controller of [granted, abandoned]) {
    const original = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) => {
      removed++;
      if (listener) original(type, listener, options);
    };
  }
  const first = admission.enter('a', 1, granted.signal);
  const second = admission.enter('a', 1, abandoned.signal).catch((error: unknown) => error);
  const third = admission.enter('a', 1, signal());
  abandoned.abort();
  expect(await second).toBeInstanceOf(Abandoned);
  expect(removed).toBe(1);
  release();
  const done = await first;
  expect(removed).toBe(2);
  granted.abort();
  expect(admission.running('a')).toBe(1);
  expect(admission.waiting('a')).toBe(1);
  done();
  (await third)();
});

test('an already fired signal rejects and takes no place', async () => {
  const admission = new Admission();
  const controller = new AbortController();
  controller.abort();
  await expect(admission.enter('a', 1, controller.signal)).rejects.toBeInstanceOf(Abandoned);
  expect(admission.running('a')).toBe(0);
  expect(admission.size()).toBe(0);
});

test('a signal fired after granting changes nothing until release', async () => {
  const admission = new Admission();
  const controller = new AbortController();
  const release = await admission.enter('a', 1, controller.signal);
  controller.abort();
  expect(admission.running('a')).toBe(1);
  release();
  expect(admission.running('a')).toBe(0);
});

test('idle ids leave no state after churn', async () => {
  const admission = new Admission();
  for (let i = 0; i < 1_000; i++) {
    const id = String(i);
    (await admission.enter(id, 1, signal()))();
    expect(admission.running(id)).toBe(0);
    expect(admission.waiting(id)).toBe(0);
  }
  expect(admission.size()).toBe(0);
});

test('notify wakes all current waiters and none that start afterwards', async () => {
  const notifier = new Notifier();
  const first = notifier.wait(signal());
  const second = notifier.wait(signal());
  notifier.notify();
  let woke = false;
  const later = notifier.wait(signal()).then(() => { woke = true; });
  await Promise.all([first, second]);
  await settled();
  expect(woke).toBe(false);
  expect(notifier.waiting()).toBe(1);
  notifier.notify();
  await later;
  expect(woke).toBe(true);
});

test('fired signals leave no notifier waiter and listeners are removed on wake or abort', async () => {
  const notifier = new Notifier();
  const fired = new AbortController();
  fired.abort();
  await expect(notifier.wait(fired.signal)).rejects.toBeInstanceOf(Abandoned);
  expect(notifier.waiting()).toBe(0);
  const wake = new AbortController();
  const abort = new AbortController();
  let removed = 0;
  for (const controller of [wake, abort]) {
    const original = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) => {
      removed++;
      if (listener) original(type, listener, options);
    };
  }
  const woken = notifier.wait(wake.signal);
  const abandoned = notifier.wait(abort.signal);
  const rejected = abandoned.catch((error: unknown) => error);
  abort.abort();
  expect(await rejected).toBeInstanceOf(Abandoned);
  expect(notifier.waiting()).toBe(1);
  expect(removed).toBe(1);
  notifier.notify();
  await woken;
  expect(removed).toBe(2);
  expect(notifier.waiting()).toBe(0);
});
