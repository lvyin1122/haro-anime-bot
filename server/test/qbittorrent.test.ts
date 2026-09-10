import { describe, expect, it } from 'vitest';

import { parseSessionCookie } from '../src/clients/qbittorrent.ts';

describe('parseSessionCookie', () => {
  it('reads the SID cookie qBittorrent 4.x issues', () => {
    expect(parseSessionCookie(['SID=abc123; HttpOnly; path=/'])).toBe('SID=abc123');
  });

  it('reads the port-suffixed cookie qBittorrent 5.x issues', () => {
    // 5.x namespaces the cookie per port so two instances on one host do not
    // clobber each other's session. Matching on the literal name "SID" missed
    // this entirely, and every request after login came back 403.
    expect(
      parseSessionCookie([
        'QBT_SID_7808=S44ybSKovWltonZzHxiyT72I4aTy1RFk; HttpOnly; expires=Thu, 10-Sep-2026 09:45:40 GMT; path=/'
      ])
    ).toBe('QBT_SID_7808=S44ybSKovWltonZzHxiyT72I4aTy1RFk');
  });

  it('picks the session cookie out of several', () => {
    expect(parseSessionCookie(['other=1; path=/', 'QBT_SID_8080=xyz; path=/'])).toBe(
      'QBT_SID_8080=xyz'
    );
  });

  it('returns nothing when there is no session cookie to find', () => {
    expect(parseSessionCookie([])).toBeUndefined();
    expect(parseSessionCookie(['theme=dark; path=/'])).toBeUndefined();
  });

  it('does not match a cookie that merely ends in SID', () => {
    expect(parseSessionCookie(['NOTASID=nope; path=/'])).toBeUndefined();
  });
});
