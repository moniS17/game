/*
 * auth.js — credential checking for the login page.
 *
 * Credentials live in the plain-text file users.txt, one account per line in
 * "username:password" form (blank lines and #-comments ignored). This file is
 * fetched at check time, so adding/removing accounts needs no code change.
 *
 * NOTE: this is a client-side check suitable for a local/offline game only.
 * The credentials are readable by anyone who can open users.txt; do not treat
 * this as real security. Swap Auth.check() for a backend request for that.
 *
 * Exposes window.Auth.
 */
window.Auth = (function () {
  // Parse "user:pass" lines into a { user -> pass } map.
  function parse(text) {
    const users = {};
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf(':');
      if (i === -1) continue;
      users[line.slice(0, i).trim()] = line.slice(i + 1); // password kept verbatim
    }
    return users;
  }

  function loadFile(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.onload = function () { resolve(xhr.responseText || ''); };
      xhr.onerror = function () { reject(new Error('Could not load ' + url)); };
      xhr.send();
    });
  }

  return {
    async check(username, password) {
      const text = await loadFile('users.txt');
      const users = parse(text);
      return Object.prototype.hasOwnProperty.call(users, username) &&
             users[username] === password;
    },
  };
})();
