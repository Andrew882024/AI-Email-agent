import { describe, expect, it } from 'vitest';
import { parseLoginHash } from './login-params';

describe('login page parameters', () => {
  it('reads the error the sign-in callback sends back', () => {
    expect(parseLoginHash('')).toEqual({});
    expect(parseLoginHash('#inbox')).toEqual({});
    expect(parseLoginHash(`#error=${encodeURIComponent('Sign-in was cancelled.')}`)).toEqual({
      error: 'Sign-in was cancelled.',
    });
  });
});
