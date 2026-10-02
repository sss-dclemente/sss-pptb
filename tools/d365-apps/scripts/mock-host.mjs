// Mocked PPTB host for the dist build (toolboxAPI, dataverseAPI, powerplatformAPI), injected as an init script.
// Shared by e2e.mjs and screenshots.mjs. window.__mock exposes the data (envs, installed, available) and call logs.
// Environments: Dev (Sandbox, the connection's), Prod (Production), Teams (no Dataverse: hidden).
// Dev: sales 1.0 (catalog 1.2: update, Installed list paged), fs InstallFailed, custom 1.0 → 1.5 (customHandleUpgrade).
// Prod: sales 1.2 (current), portal Installing, extra available only (install returns no operation id → state fallback).
// Empty (nothing installed, extra available: still "empty"), Broken (Installed list fails: error column, never auto-hidden).
export const MOCK = `
(() => {
  const M = window.__mock = { gets: [], posts: [], saved: [], notes: [], listeners: [], fail403: false, active: {}, maxActive: 0, maxEnvs: 0 };
  const envs = [
    { id: 'env-dev', displayName: 'SSS Dev', type: 'Sandbox', state: 'Ready', dataverseId: 'org-dev', url: 'https://sss-dev.crm4.dynamics.com', geo: 'europe' },
    { id: 'env-prod', displayName: 'SSS Prod', type: 'Production', state: 'Ready', dataverseId: 'org-prod', url: 'https://sss.crm4.dynamics.com', geo: 'europe' },
    { id: 'env-teams', displayName: 'Teams Room', type: 'Teams', state: 'Ready', geo: 'europe' },
    { id: 'env-empty', displayName: 'SSS Empty', type: 'Developer', state: 'Ready', dataverseId: 'org-empty', url: 'https://sss-empty.crm4.dynamics.com', geo: 'europe' },
    { id: 'env-broken', displayName: 'SSS Broken', type: 'Sandbox', state: 'Ready', dataverseId: 'org-broken', url: 'https://sss-broken.crm4.dynamics.com', geo: 'europe' },
  ];
  M.envs = envs; // the tests add environments later (many-environment preview)
  const P = (uniqueName, version, state, extra = {}) => ({ uniqueName, localizedName: uniqueName.replace(/^msdyn_/, '').toUpperCase(), version, state, publisherName: 'Microsoft', ...extra });
  M.installed = {
    'env-dev': [P('msdyn_sales', '1.0.0.0', 'Installed'), P('msdyn_fs', '2.0.0.0', 'InstallFailed', { lastError: { message: 'Dependency msdyn_anchor missing' } }), P('msdyn_custom', '1.0.0.0', 'Installed', { customHandleUpgrade: true }), P('msdyn_teamsapp', '3.1.0.0', 'Installed')],
    'env-prod': [P('msdyn_sales', '1.2.0.0', 'Installed'), P('msdyn_portal', '5.0.0.0', 'Installing')],
  };
  M.available = {
    'env-dev': [P('msdyn_sales', '1.2.0.0', 'None'), P('msdyn_custom', '1.5.0.0', 'None', { customHandleUpgrade: true }), P('msdyn_fs', '2.0.0.0', 'None')],
    'env-prod': [P('msdyn_sales', '1.2.0.0', 'None'), P('msdyn_extra', '7.0.0.0', 'None')],
    'env-empty': [P('msdyn_extra', '7.0.0.0', 'None')],
  };
  const ops = {};
  const err = (msg) => { throw new Error('Power Platform request failed: ' + msg); };
  const pageOf = (list, path) => {
    // page the Installed list of Dev in two to exercise @odata.nextLink
    const m = path.match(/[$]skiptoken=(\\d+)/);
    const start = m ? Number(m[1]) : 0;
    const size = path.includes('env-dev') && path.includes('appInstallState=Installed') ? 2 : 100;
    const out = { value: list.slice(start, start + size) };
    if (start + size < list.length) out['@odata.nextLink'] = 'https://api.powerplatform.com/appmanagement/' + path.replace(/&[$]skiptoken=\\d+/, '') + '&$skiptoken=' + (start + size);
    return out;
  };
  const track = (envId, d) => {
    M.active[envId] = (M.active[envId] || 0) + d;
    M.maxActive = Math.max(M.maxActive, ...Object.values(M.active));
    M.maxEnvs = Math.max(M.maxEnvs, Object.values(M.active).filter((n) => n > 0).length);
  };
  const finish = (envId, name, ok) => {
    track(envId, -1);
    if (!ok) return;
    const target = (M.available[envId] || []).filter((p) => p.uniqueName === name).sort((a, b) => b.version.localeCompare(a.version))[0];
    const list = M.installed[envId] = M.installed[envId] || [];
    const cur = list.find((p) => p.uniqueName === name);
    if (cur) Object.assign(cur, { version: target ? target.version : cur.version, state: 'Installed', lastError: undefined });
    else list.push(P(name, target ? target.version : '1.0.0.0', 'Installed'));
  };
  window.powerplatformAPI = {
    EnvironmentManagement: {
      Get: async (path) => {
        M.gets.push('env:' + path);
        if (M.fail403) err('HTTP 403: Forbidden');
        if (!/^environments[?]api-version=2024-10-01$/.test(path)) err('mock: bad environments path ' + path);
        return { value: envs };
      },
    },
    AppManagement: {
      Get: async (path) => {
        M.gets.push(path);
        await new Promise((r) => setTimeout(r, 5));
        let m;
        if ((m = path.match(/^environments[/]([^/]+)[/]applicationPackages[?]appInstallState=(Installed|NotInstalled)&api-version=2024-10-01/))) {
          const envId = decodeURIComponent(m[1]);
          if (envId === 'env-teams') err('mock: teams env has no Dataverse');
          if (envId === 'env-broken') err('HTTP 500: Internal Server Error');
          const list = m[2] === 'Installed' ? (M.installed[envId] || []) : (M.available[envId] || []);
          if (M.pending && M.pending[envId] && m[2] === 'Installed') {
            const p = M.pending[envId];
            if (++p.polls >= 2) { delete M.pending[envId]; finish(envId, p.name, true); }
            else return { value: [...list.filter((x) => x.uniqueName !== p.name), P(p.name, '7.0.0.0', 'Installing')] };
          }
          return pageOf(list.map((x) => ({ ...x })), path);
        }
        if ((m = path.match(/^environments[/]([^/]+)[/]operations[/]([^?]+)[?]api-version=2024-10-01$/))) {
          const o = ops[decodeURIComponent(m[2])];
          if (!o) err('HTTP 404: no operation');
          o.polls++;
          if (o.polls < 2) return { status: 'Running', operationId: o.id };
          if (!o.done) { o.done = true; finish(o.envId, o.name, !o.fail); }
          return o.fail ? { status: 'Failed', error: { message: 'Solution msdyn_fs failed to import: missing dependency' }, operationId: o.id } : { status: 'Succeeded', operationId: o.id };
        }
        err('mock: unexpected GET ' + path);
      },
      Post: async (path, body) => {
        M.posts.push({ path, body });
        const m = path.match(/^environments[/]([^/]+)[/]applicationPackages[/]([^/]+)[/]install[?]api-version=2024-10-01$/);
        if (!m) err('mock: unexpected POST ' + path);
        const envId = decodeURIComponent(m[1]);
        const name = decodeURIComponent(m[2]);
        track(envId, 1);
        if (name === 'msdyn_extra') { M.pending = { ...(M.pending || {}), [envId]: { name, polls: 0 } }; return {}; }
        const id = 'op-' + envId + '-' + name;
        ops[id] = { id, envId, name, polls: 0, fail: name === 'msdyn_fs' };
        return { id: 'instance-' + name, packageUniqueName: name, lastOperation: { operationId: id, state: 'InstallRequested' } };
      },
    },
  };
  window.dataverseAPI = {
    execute: async (req) => {
      if (req.operationName === 'RetrieveCurrentOrganization') return { Detail: { EnvironmentId: 'env-dev' } };
      throw new Error('mock: unexpected execute ' + req.operationName);
    },
    // Unused apps (Dev): msdyn_sales owns msdyn_quote (rows); msdyn_teamsapp (anchor) owns msdyn_tile (empty); msdyn_common shared
    queryData: async (q) => {
      M.dvq = M.dvq || [];
      M.dvq.push(q);
      const G = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
      const page = (value) => ({ value });
      if (q.startsWith('solutions?')) return page([
        { solutionid: G(1), uniquename: 'msdyn_SalesCore', friendlyname: 'Sales core', version: '1.2' },
        { solutionid: G(2), uniquename: 'msdyn_teamsapp', friendlyname: 'Teams app', version: '3.1' },
        { solutionid: G(3), uniquename: 'msdyn_common', friendlyname: 'Common', version: '1.0' },
      ]);
      if (q.startsWith('msdyn_solutionhistories?')) return page([
        { msdyn_name: 'msdyn_SalesCore', msdyn_packagename: 'msdyn_sales', msdyn_operation: 0, msdyn_result: true },
        { msdyn_name: 'msdyn_common', msdyn_packagename: 'msdyn_sales', msdyn_operation: 0, msdyn_result: true },
        { msdyn_name: 'msdyn_common', msdyn_packagename: 'msdyn_teamsapp', msdyn_operation: 0, msdyn_result: true },
      ]);
      if (q.startsWith('solutioncomponents?')) return page([
        { objectid: G(11), componenttype: 1, _solutionid_value: G(1) },
        { objectid: G(12), componenttype: 1, _solutionid_value: G(2) },
        { objectid: G(13), componenttype: 1, _solutionid_value: G(3) },
        { objectid: G(21), componenttype: 80, _solutionid_value: G(2) },
      ].filter((c) => q.includes(c._solutionid_value)));
      if (q.startsWith('EntityDefinitions?')) return page([
        { MetadataId: G(11), LogicalName: 'msdyn_quote', EntitySetName: 'msdyn_quotes', PrimaryIdAttribute: 'msdyn_quoteid', IsCustomEntity: true, IsIntersect: false, TableType: 'Standard' },
        { MetadataId: G(12), LogicalName: 'msdyn_tile', EntitySetName: 'msdyn_tiles', PrimaryIdAttribute: 'msdyn_tileid', IsCustomEntity: true, IsIntersect: false, TableType: 'Standard' },
        { MetadataId: G(13), LogicalName: 'msdyn_shared', EntitySetName: 'msdyn_shareds', PrimaryIdAttribute: 'msdyn_sharedid', IsCustomEntity: true, IsIntersect: false, TableType: 'Standard' },
      ]);
      if (q.startsWith('RetrieveTotalRecordCount(EntityNames=@p1)?@p1=')) {
        const names = JSON.parse(decodeURIComponent(q.split('@p1=')[1]));
        const n = { msdyn_quote: 1234, msdyn_tile: 0 };
        const keys = names.filter((k) => k in n);
        return { EntityRecordCountCollection: { Count: keys.length, IsReadOnly: false, Keys: keys, Values: keys.map((k) => n[k]) } };
      }
      if (q === 'msdyn_tiles?$select=msdyn_tileid&$top=1') return page([]);
      if (q.startsWith('appmodules?')) return page([{ appmoduleid: G(21), name: 'Teams Hub', uniquename: 'msdyn_teamshub', appmoduleroles_association: [{ roleid: G(31) }] }]);
      throw new Error('mock: unexpected queryData ' + q);
    },
  };
  window.toolboxAPI = {
    connections: { getActiveConnection: async () => ({ id: 'c1', name: 'SSS Dev', url: 'https://sss-dev.crm4.dynamics.com', environment: 'Dev', environmentColor: '#0f766e' }), getSecondaryConnection: async () => null },
    utils: { getCurrentTheme: async () => 'light', showNotification: async (o) => { M.notes.push(o); } },
    events: { on(cb) { M.listeners.push(cb); } },
    fileSystem: { saveFile: async (name, content) => { M.saved.push({ name, content }); return '/tmp/' + name; }, selectPath: async () => null, readText: async () => '', readBinary: async () => null },
  };
  M.emit = (event) => M.listeners.forEach((cb) => cb({}, { event }));
})();
`;
