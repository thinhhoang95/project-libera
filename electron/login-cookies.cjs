const SESSION_COOKIE_NAME = "libera_session";

async function clearLoginCookie(electronSession, url) {
  await electronSession.cookies.remove(url, SESSION_COOKIE_NAME);
}

module.exports = { clearLoginCookie, SESSION_COOKIE_NAME };
