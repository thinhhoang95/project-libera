export const LOGIN_WALLPAPERS = [
  { id: "alpine", name: "Alpine lake", background: 'url("/images/login-alpine-lake.png") center / cover no-repeat' },
  { id: "cloud", name: "Cloud", background: "radial-gradient(ellipse at 9% 72%, #dad3ff99, transparent 38%), radial-gradient(ellipse at 88% 12%, #e9ddff80, transparent 35%), radial-gradient(ellipse at 65% 65%, #c3ddffb3, transparent 49%), linear-gradient(125deg, #e4efff, #f5faff 45%, #dceaff)" },
  { id: "dawn", name: "Dawn", background: "radial-gradient(ellipse at 15% 80%, #f4b6c5, transparent 55%), linear-gradient(135deg, #ffe5d0, #fff4e9 45%, #e4ceef)" },
  { id: "sage", name: "Sage", background: "radial-gradient(ellipse at 80% 20%, #bbdacb, transparent 60%), linear-gradient(135deg, #e9f1db, #eff8f1 45%, #badbd7)" },
  { id: "lavender", name: "Lavender", background: "radial-gradient(ellipse at 20% 30%, #d8b9ec, transparent 55%), linear-gradient(135deg, #eee5ff, #f5eefb 45%, #bfc8ef)" },
  { id: "ocean", name: "Ocean", background: "radial-gradient(ellipse at 80% 75%, #5daecb, transparent 60%), linear-gradient(135deg, #c8f1ee, #e5f5fc 40%, #9abfea)" },
  { id: "midnight", name: "Midnight", background: "radial-gradient(ellipse at 20% 80%, #4b427a, transparent 55%), radial-gradient(ellipse at 85% 15%, #315e85, transparent 50%), linear-gradient(135deg, #172038, #28334e)" },
] as const;

export const CUSTOM_WALLPAPER = { id: "custom", name: "Custom image", background: 'url("/api/preferences/login-wallpaper") center / cover no-repeat' } as const;

const COOKIE_NAME = "libera-login-wallpaper";
const CHANGE_EVENT = "libera-login-wallpaper-change";

export function readLoginWallpaper() {
  const value = document.cookie.split("; ").find((cookie) => cookie.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  if (value === "custom") return CUSTOM_WALLPAPER;
  return LOGIN_WALLPAPERS.find((wallpaper) => wallpaper.id === value) ?? LOGIN_WALLPAPERS[0];
}

export function saveLoginWallpaper(id: string) {
  if (id !== "custom" && !LOGIN_WALLPAPERS.some((wallpaper) => wallpaper.id === id)) return false;
  // Cookies are host-scoped, so Electron's changing server port does not reset the choice.
  document.cookie = `${COOKIE_NAME}=${id}; Path=/; Max-Age=31536000; SameSite=Lax`;
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return readLoginWallpaper().id === id;
}

export function subscribeLoginWallpaper(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("focus", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("focus", onChange);
  };
}

export function defaultLoginWallpaper() { return LOGIN_WALLPAPERS[0]; }
