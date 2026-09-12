/**
 * Where the authoring server is (D-565).
 *
 * `npm run dev:studio` serves the studio, the creation tool and the asset
 * tabs from one port. It runs under `tsx` with no reload, so a change to a
 * shared SCHEMA means restarting it — and a schema the running process has
 * never heard of comes back as a 500 that reads like a broken route.
 *
 * ⚠ Hence the override. Starting a second server on another port
 * (`STUDIO_PORT=8151 npm run dev:studio`) and opening
 * `/creation-tool.html?api=8151` is the fastest way to pick up a schema change
 * without stopping the one already running — and it is the difference between
 * noticing a stale server in a second and spending ten minutes on a route that
 * was never wrong.
 */
const override = new URLSearchParams(globalThis.location?.search ?? '').get('api');
const port = override && /^\d+$/.test(override) ? override : '8150';

export const API = override && !/^\d+$/.test(override) ? override : `http://localhost:${port}/api`;
