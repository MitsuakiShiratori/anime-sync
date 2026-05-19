/* ============================================================
 * AnimeSync — Supabase 同期レイヤ（全ページ共通）
 *
 *  役割:
 *   - メール＋パスワード認証（Supabase Auth, セッションは端末localStorageに永続）
 *   - ログイン中はどのページを開いても season_sync テーブルから
 *     as_my_season を pull（updated_at 比較）。内容が変わったら 1 回だけ
 *     reload して各ページを最新データで再描画
 *   - discover 等から AnimeSync.pushSeason() で push（upsert）
 *
 *  ★ anon(公開) キーは RLS 前提でクライアントに置いて安全な鍵です
 *    （service_role キーは絶対にここへ置かないこと）。
 *  ★ 下の SUPABASE_URL / SUPABASE_ANON_KEY を自分のプロジェクト値に
 *    置き換えるまで、この機能は何もしません（既存動作は不変）。
 * ============================================================ */
(function () {
  'use strict';

  // ▼▼▼ ここを自分の Supabase プロジェクトの値に置き換える ▼▼▼
  var SUPABASE_URL      = 'https://idciktxylicjonefjqfr.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkY2lrdHh5bGljam9uZWZqcWZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNjMyMTIsImV4cCI6MjA4NzczOTIxMn0.UEkyps4lpL8S4XCo8ECl8Ptr4Rd5w_vD7BrFUjDBvR4';
  // ▲▲▲ Project Settings → API で確認できます ▲▲▲

  var SEASON_KEY = 'as_my_season';
  var SYNC_AT    = 'as_my_season_sync_at';   // 最後に取り込んだ remote updated_at
  var RELOAD_GUARD = 'as_sync_reloaded';     // sessionStorage: reload ループ防止
  var TABLE      = 'season_sync';
  var SDK_URL    = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

  var configured = !/YOUR-PROJECT-ref|YOUR-PUBLIC-ANON-KEY/.test(SUPABASE_URL + SUPABASE_ANON_KEY);

  // ---- ローカル as_my_season ヘルパ ----
  function localSeason() {
    try { var v = JSON.parse(localStorage.getItem(SEASON_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function setLocalSeason(arr) {
    try { localStorage.setItem(SEASON_KEY, JSON.stringify(arr || [])); } catch (e) {}
  }
  // 並び順に依存しない比較（id 集合で判定）
  function sig(arr) {
    try { return (arr || []).map(function (a) { return a && a.id; }).filter(Boolean).sort().join('|'); }
    catch (e) { return ''; }
  }

  var listeners = [];
  function emit(evt, payload) {
    listeners.forEach(function (cb) { try { cb(evt, payload); } catch (e) {} });
    try { window.dispatchEvent(new CustomEvent('animesync:' + evt, { detail: payload })); } catch (e) {}
  }

  // ---- SDK 動的ロード ----
  function loadSDK() {
    return new Promise(function (resolve, reject) {
      if (window.supabase && window.supabase.createClient) return resolve();
      var s = document.createElement('script');
      s.src = SDK_URL;
      s.async = true;
      s.onload = function () {
        (window.supabase && window.supabase.createClient) ? resolve() : reject(new Error('sdk'));
      };
      s.onerror = function () { reject(new Error('sdk-network')); };
      document.head.appendChild(s);
    });
  }

  var client = null;

  // ---- pull: remote → local（必要なら 1 回 reload） ----
  function pull() {
    if (!client) return Promise.resolve();
    return client.auth.getUser().then(function (res) {
      var user = res && res.data && res.data.user;
      if (!user) { emit('auth', { user: null }); return; }
      emit('auth', { user: user });
      return client.from(TABLE)
        .select('data, updated_at')
        .eq('user_id', user.id)
        .maybeSingle()
        .then(function (r) {
          if (r.error) { emit('error', r.error); return; }
          var row = r.data;
          if (!row) {                                  // リモート未作成 → 現ローカルを初期push
            return pushSeason().then(function () { emit('synced', { direction: 'init' }); });
          }
          var lastAt = localStorage.getItem(SYNC_AT) || '';
          var changed = sig(row.data) !== sig(localSeason());
          // remote の方が新しい、またはローカル未同期なら取り込む
          if (row.updated_at && row.updated_at !== lastAt) {
            setLocalSeason(row.data || []);
            try { localStorage.setItem(SYNC_AT, row.updated_at); } catch (e) {}
            emit('synced', { direction: 'pull' });
            // reload ガードは updated_at をキーにする:
            //  同一 updated_at では二度 reload しない（ループ/書込失敗時も安全）。
            //  別デバイスの新しい変更（updated_at が変化）なら再 reload を許可。
            var guardVal = '';
            try { guardVal = sessionStorage.getItem(RELOAD_GUARD) || ''; } catch (e) {}
            if (changed && guardVal !== row.updated_at) {
              try { sessionStorage.setItem(RELOAD_GUARD, row.updated_at); } catch (e) {}
              location.reload();                        // 各ページを最新データで再描画
            }
          } else if (changed) {
            // updated_at は同じだが内容差 → ローカル変更が未pushとみなし push
            return pushSeason();
          }
        });
    }).catch(function (e) { emit('error', e); });
  }

  // ---- push: local → remote（upsert） ----
  function pushSeason() {
    if (!client) return Promise.resolve({ skipped: true });
    return client.auth.getUser().then(function (res) {
      var user = res && res.data && res.data.user;
      if (!user) return { skipped: true };
      var now = new Date().toISOString();
      return client.from(TABLE)
        .upsert({ user_id: user.id, data: localSeason(), updated_at: now }, { onConflict: 'user_id' })
        .then(function (r) {
          if (r.error) { emit('error', r.error); return r; }
          try { localStorage.setItem(SYNC_AT, now); } catch (e) {}
          emit('synced', { direction: 'push' });
          return r;
        });
    });
  }

  // ---- 公開 API ----
  var API = {
    configured: configured,
    get client() { return client; },
    ready: false,

    onChange: function (cb) { if (typeof cb === 'function') listeners.push(cb); },

    getUser: function () {
      if (!client) return Promise.resolve(null);
      return client.auth.getUser().then(function (r) { return (r && r.data && r.data.user) || null; });
    },

    signUp: function (email, password) {
      if (!client) return Promise.reject(new Error('未設定'));
      return client.auth.signUp({ email: email, password: password }).then(function (r) {
        if (r.error) throw r.error;
        // Confirm email OFF なら即セッション発行 → 現ローカルを初期 push
        if (r.data && r.data.session) { pushSeason(); }
        return r.data;
      });
    },

    signIn: function (email, password) {
      if (!client) return Promise.reject(new Error('未設定'));
      return client.auth.signInWithPassword({ email: email, password: password }).then(function (r) {
        if (r.error) throw r.error;
        return r.data;
      });
    },

    // Google OAuth: 現ページへ戻るフルリダイレクト。
    // 復帰時に supabase-js が URL のトークンを検出 → onAuthStateChange
    // (SIGNED_IN) → pull() が走り、各ページへ同期される。
    signInWithGoogle: function () {
      if (!client) return Promise.reject(new Error('未設定'));
      var redirectTo = location.origin + location.pathname;
      return client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: redirectTo }
      }).then(function (r) { if (r.error) throw r.error; return r.data; });
    },

    signOut: function () {
      if (!client) return Promise.resolve();
      return client.auth.signOut(); // ローカルの as_my_season は保持（消さない）
    },

    pushSeason: pushSeason,
    pull: pull,
  };
  window.AnimeSync = API;

  if (!configured) {
    // 未設定: 既存動作のまま。UI には「未設定」を伝える
    API.ready = true;
    emit('config', { configured: false });
    return;
  }

  loadSDK().then(function () {
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'as_supabase_auth' }
    });
    API.ready = true;
    emit('config', { configured: true });

    client.auth.onAuthStateChange(function (event) {
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') { pull(); }
      if (event === 'SIGNED_OUT') {
        try { sessionStorage.removeItem(RELOAD_GUARD); } catch (e) {}
        emit('auth', { user: null });
      }
    });

    // 初回ロード時に pull（onAuthStateChange が発火しない環境向けの保険）
    pull();
  }).catch(function (e) {
    API.ready = true;
    emit('error', e);
  });
})();
