import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from "react";
import { ArrowRight, BookOpen, Check, Eye, EyeOff, ImagePlus, LockKeyhole, MoreHorizontal } from "lucide-react";
import { WindowControls } from "@/components/libera/window-controls";
import styles from "./login-screen.module.css";
import { defaultLoginWallpaper, LOGIN_WALLPAPERS, readLoginWallpaper, saveLoginWallpaper, subscribeLoginWallpaper } from "./login-wallpaper";

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
  const imageInput = useRef<HTMLInputElement>(null);
  const wallpaper = useSyncExternalStore(subscribeLoginWallpaper, readLoginWallpaper, defaultLoginWallpaper);
  const customBackground = `url("/api/preferences/login-wallpaper?v=${imageVersion}") center / cover no-repeat`;

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
    <main className={`libera-login-screen ${styles.screen}`} style={{ "--login-wallpaper": wallpaper.id === "custom" ? customBackground : wallpaper.background } as CSSProperties}>
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
      <section className={styles.card} aria-labelledby="login-heading">
        <div className={styles.brand}>
          <span className={styles.brandIcon}><BookOpen aria-hidden size={40} strokeWidth={1.5} /></span>
          <div>
            <p className={styles.brandName}>Libera</p>
            <p className={styles.tagline}>Your knowledge, organized</p>
          </div>
        </div>
        <h1 id="login-heading" className={styles.heading}>
          {yourName ? `Welcome, ${yourName}` : "Sign in"}
        </h1>
        <p className={styles.subtitle}>
          Sign in to continue to your notebooks.
        </p>
        <form className={styles.form} onSubmit={onLogin} aria-busy={busy}>
          <label className={styles.label} htmlFor="password">
            Password
          </label>
          <div className={styles.passwordField}>
            <LockKeyhole aria-hidden size={21} />
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              placeholder="Enter your password"
              autoComplete="current-password"
              aria-invalid={Boolean(authError)}
              aria-describedby={authError ? "login-error" : undefined}
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              autoFocus
            />
            <button
              className={styles.visibilityButton}
              type="button"
              aria-label={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword((visible) => !visible)}
            >
              {showPassword ? <Eye aria-hidden size={21} /> : <EyeOff aria-hidden size={21} />}
            </button>
          </div>
          {authError ? <p id="login-error" role="alert" className={styles.error}>{authError}</p> : null}
          <button
            className={styles.submit}
            type="submit"
            disabled={busy}
          >
            {busy ? "Signing in" : "Sign in"}
            <ArrowRight aria-hidden size={20} />
          </button>
        </form>
      </section>
    </main>
  );
}
