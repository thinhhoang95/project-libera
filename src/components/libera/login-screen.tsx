import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from "react";
import { ArrowRight, Check, Eye, EyeOff, ImagePlus, LoaderCircle, MoreHorizontal } from "lucide-react";
import { WindowControls } from "@/components/libera/window-controls";
import styles from "./login-screen.module.css";
import { defaultLoginWallpaper, LOGIN_WALLPAPERS, readLoginWallpaper, saveLoginWallpaper, subscribeLoginWallpaper } from "./login-wallpaper";
import { detectWallpaperLook, type WallpaperLook } from "./login-wallpaper-tone";

const FALLBACK_LOOK: WallpaperLook = { tone: "light", logo: ["#106660", "#106660"] };

type LoginScreenProps = {
  yourName: string;
  authError: string;
  busy: boolean;
  password: string;
  onLogin: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onPasswordChange: (password: string) => void;
};

export function LoginScreen({
  yourName,
  authError,
  busy,
  password,
  onLogin,
  onPasswordChange,
}: LoginScreenProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [wallpaperError, setWallpaperError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);
  const [hasCustomImage, setHasCustomImage] = useState(false);
  const [look, setLook] = useState<WallpaperLook>();
  const imageInput = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const wallpaper = useSyncExternalStore(subscribeLoginWallpaper, readLoginWallpaper, defaultLoginWallpaper);
  const customBackground = `url("/api/preferences/login-wallpaper?v=${imageVersion}") center / cover no-repeat`;
  const background = wallpaper.id === "custom" ? customBackground : wallpaper.background;

  useEffect(() => {
    const controller = new AbortController();
    detectWallpaperLook(background, controller.signal)
      .catch(() => FALLBACK_LOOK)
      .then((value) => { if (!controller.signal.aborted) setLook(value); });
    return () => controller.abort();
  }, [background]);

  // Shake the field after a rejected attempt, as macOS does.
  useEffect(() => {
    if (busy || !authError || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    field.current?.animate(
      [0, -10, 9, -7, 5, -3, 0].map((x) => ({ transform: `translateX(${x}px)` })),
      { duration: 420, easing: "ease-out" },
    );
  }, [busy, authError]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/preferences/login-wallpaper", { method: "HEAD", signal: controller.signal })
      .then((response) => setHasCustomImage(response.ok))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  async function uploadWallpaper(file: File) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      setWallpaperError("Choose a PNG, JPEG, or WebP smaller than 10 MB.");
      return;
    }
    setUploading(true);
    setWallpaperError("");
    try {
      const response = await fetch("/api/preferences/login-wallpaper", { method: "POST", headers: { "Content-Type": file.type }, body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not save your wallpaper.");
      setImageVersion((version) => version + 1);
      setHasCustomImage(true);
      if (!saveLoginWallpaper("custom")) throw new Error("Image saved, but the selection could not be remembered. Please enable cookies.");
    } catch (error) {
      setWallpaperError(error instanceof Error ? error.message : "Could not save your wallpaper.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <main
      className={`libera-login-screen ${styles.screen}`}
      data-tone={look?.tone ?? "light"}
      data-ready={look ? "" : undefined}
      style={{
        "--login-wallpaper": background,
        "--logo-from": (look ?? FALLBACK_LOOK).logo[0],
        "--logo-to": (look ?? FALLBACK_LOOK).logo[1],
      } as CSSProperties}
    >
      <div className="libera-window-drag-region fixed inset-x-0 top-0 h-12" aria-hidden />
      <div className={`libera-window-no-drag fixed right-3 top-3 z-50 ${styles.toolbar}`}>
        <button type="button" className={styles.wallpaperTrigger} popoverTarget="login-wallpapers" aria-label="Choose login wallpaper" title="Choose login wallpaper">
          <MoreHorizontal aria-hidden size={22} />
        </button>
        <WindowControls />
      </div>
      <div id="login-wallpapers" popover="auto" className={`libera-window-no-drag ${styles.wallpaperPicker}`}>
        <h2>Login wallpaper</h2>
        <p>Make this space yours.</p>
        <div className={styles.wallpaperGrid}>
          {LOGIN_WALLPAPERS.map((option) => (
            <button key={option.id} type="button" disabled={uploading} className={styles.wallpaperOption} aria-pressed={wallpaper.id === option.id} onClick={() => {
              try {
                setWallpaperError(saveLoginWallpaper(option.id) ? "" : "Could not save your wallpaper. Please enable cookies and try again.");
              } catch {
                setWallpaperError("Could not save your wallpaper. Please try again.");
              }
            }}>
              <span className={styles.wallpaperSwatch} style={{ background: option.background }}>
                {wallpaper.id === option.id && <Check aria-hidden size={18} />}
              </span>
              <span>{option.name}</span>
            </button>
          ))}
          <button type="button" className={styles.wallpaperOption} disabled={uploading} aria-label="Custom image" aria-pressed={wallpaper.id === "custom"} onClick={() => {
            if (hasCustomImage || wallpaper.id === "custom") {
              try { if (!saveLoginWallpaper("custom")) setWallpaperError("Could not remember your selection."); }
              catch { setWallpaperError("Could not remember your selection."); }
            } else imageInput.current?.click();
          }}>
            <span className={styles.wallpaperSwatch} style={{ background: (hasCustomImage || wallpaper.id === "custom") ? customBackground : "#e7edf8" }}>
              <ImagePlus aria-hidden size={18} />
            </span>
            <span>{uploading ? "Saving…" : "Custom"}</span>
          </button>
        </div>
        <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-label="Upload custom wallpaper" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void uploadWallpaper(file);
        }} />
        <button type="button" className={styles.uploadButton} disabled={uploading} onClick={() => imageInput.current?.click()}>Choose an image…</button>
        <p>PNG, JPEG or WebP · up to 10 MB</p>
        {wallpaperError && <p role="alert" className={styles.error}>{wallpaperError}</p>}
      </div>
      <div className={styles.scrim} aria-hidden />
      <section className={styles.account} aria-labelledby="login-heading">
        <div className={styles.logo} role="img" aria-label="Libera">
          <span className={styles.logoInk} />
        </div>
        <h1 id="login-heading" className={styles.heading}>
          {yourName ? `Welcome, ${yourName}` : "Welcome to Libera"}
        </h1>
        <form className={styles.form} onSubmit={onLogin} aria-busy={busy}>
          <label className={styles.label} htmlFor="password">
            Password
          </label>
          <div ref={field} className={styles.passwordField}>
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              placeholder="Enter password"
              autoComplete="current-password"
              aria-invalid={Boolean(authError)}
              aria-describedby={authError ? "login-error" : undefined}
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              autoFocus
            />
            <button
              className={styles.fieldButton}
              type="button"
              aria-label={showPassword ? "Hide password" : "Show password"}
              title={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword((visible) => !visible)}
            >
              {showPassword ? <EyeOff aria-hidden size={15} /> : <Eye aria-hidden size={15} />}
            </button>
            <button className={styles.submit} type="submit" disabled={busy || !password} aria-label={busy ? "Signing in" : "Sign in"} title="Sign in">
              {busy ? <LoaderCircle aria-hidden size={16} className={styles.spinner} /> : <ArrowRight aria-hidden size={16} strokeWidth={2.5} />}
            </button>
          </div>
          <p id="login-error" role="alert" className={styles.hint} data-error={authError ? "" : undefined}>
            {authError || (busy ? "Signing in…" : " ")}
          </p>
        </form>
      </section>
    </main>
  );
}
