// SPDX-License-Identifier: AGPL-3.0-only
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoginPage from '@/views/LoginPage.vue';
import SetupPage from '@/views/SetupPage.vue';
import { createPlugins } from './helpers';
import { mockFetch, problem, USER } from './fetch-mock';

afterEach(() => vi.unstubAllGlobals());

async function mountPage(component: typeof LoginPage, path: string) {
  const plugins = await createPlugins(path);
  const wrapper = mount(component, {
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  return { wrapper, router: plugins.router };
}

async function fill(wrapper: ReturnType<typeof mount>, values: string[]) {
  const inputs = wrapper.findAll('input');
  for (const [i, value] of values.entries()) await inputs[i]!.setValue(value);
}

describe('LoginPage', () => {
  it('shows a generic error for wrong credentials', async () => {
    mockFetch({ 'POST /api/v1/auth/login': problem(401, 'Invalid email or password') });
    const { wrapper } = await mountPage(LoginPage, '/login');
    await fill(wrapper, ['ada@example.com', 'wrong password']);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('Invalid email or password.');
  });

  it('explains when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { wrapper } = await mountPage(LoginPage, '/login');
    await fill(wrapper, ['ada@example.com', 'password']);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('cannot be reached');
  });

  it('signs in and returns to the page the user wanted', async () => {
    mockFetch({ 'POST /api/v1/auth/login': { status: 200, body: { user: USER } } });
    const { wrapper, router } = await mountPage(LoginPage, '/login?redirect=/docker');
    await fill(wrapper, [USER.email, 'correct password']);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    // The old /docker link redirects to Containers. Under a loaded test run the lazy
    // route component can take more than the default second.
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/containers'), {
      timeout: 5000,
    });
  });

  it('ignores redirects to other sites', async () => {
    mockFetch({ 'POST /api/v1/auth/login': { status: 200, body: { user: USER } } });
    const { wrapper, router } = await mountPage(LoginPage, '/login?redirect=//evil.example');
    await fill(wrapper, [USER.email, 'correct password']);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
  });
});

describe('SetupPage', () => {
  it('validates the password length before calling the API', async () => {
    const { fetchMock } = mockFetch({});
    const { wrapper } = await mountPage(SetupPage, '/setup');
    await fill(wrapper, ['ABCD-EFGH-JKMN', 'Ada', 'ada@example.com', 'short']);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Use at least 10 characters.');
  });

  it('explains an invalid setup code', async () => {
    mockFetch({ 'POST /api/v1/setup': problem(403, 'Invalid setup code') });
    const { wrapper } = await mountPage(SetupPage, '/setup');
    await fill(wrapper, ['WRONG', 'Ada', 'ada@example.com', 'long enough password']);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('setup code is not valid');
  });

  it('creates the admin and opens the app', async () => {
    const { calls } = mockFetch({ 'POST /api/v1/setup': { status: 201, body: { user: USER } } });
    const { wrapper, router } = await mountPage(SetupPage, '/setup');
    await fill(wrapper, [' ABCD-EFGH-JKMN ', 'Ada Admin', USER.email, 'long enough password']);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls[0]!.body).toEqual({
      code: 'ABCD-EFGH-JKMN',
      name: 'Ada Admin',
      email: USER.email,
      password: 'long enough password',
    });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
  });
});
