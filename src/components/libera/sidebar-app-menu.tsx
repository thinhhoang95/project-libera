import { ChevronRight, Info, LogOut, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { AboutDialog } from "@/components/libera/about-dialog";
import type { ThemePreference } from "@/lib/theme";
import { isThemePreference, THEME_STORAGE_KEY } from "@/lib/theme";

type SidebarAppMenuProps = {
  collapsed?: boolean;
  onLogout: () => Promise<void>;
};

const MENU_GAP_PX = 8;
const MENU_WIDTH_PX = 176;
const MENU_WITH_SUBMENU_WIDTH_PX = 352;

type MenuPosition = {
  bottom: number;
  left: number;
};

function systemThemePreference(): ThemePreference {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function storedThemePreference(): ThemePreference {
  const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);

  return isThemePreference(savedTheme) ? savedTheme : systemThemePreference();
}

function applyThemePreference(theme: ThemePreference) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

export function SidebarAppMenu({
  collapsed = false,
  onLogout,
}: SidebarAppMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition>({
    bottom: 0,
    left: 0,
  });
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>("light");
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      const nextTheme = storedThemePreference();

      applyThemePreference(nextTheme);
      setTheme(nextTheme);
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function closeMenu() {
      setMenuOpen(false);
    }

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        closeMenu();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeMenu();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  function openAboutDialog() {
    setMenuOpen(false);
    setAboutDialogOpen(true);
  }

  function toggleDarkMode() {
    const nextTheme = theme === "dark" ? "light" : "dark";

    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    applyThemePreference(nextTheme);
    setTheme(nextTheme);
    void apiRequest<{ theme: ThemePreference }>("/api/preferences/theme", {
      body: JSON.stringify({ theme: nextTheme }),
      method: "PATCH",
    }).catch(() => null);
  }

  function toggleMenu() {
    const rect = menuRef.current?.getBoundingClientRect();

    if (rect) {
      const preferredLeft = rect.left + (collapsed ? 8 : 12);
      const maxLeft = Math.max(MENU_GAP_PX, window.innerWidth - MENU_WITH_SUBMENU_WIDTH_PX);

      setMenuPosition({
        bottom: Math.max(MENU_GAP_PX, window.innerHeight - rect.top + MENU_GAP_PX),
        left: Math.max(MENU_GAP_PX, Math.min(preferredLeft, maxLeft)),
      });
    }

    setMenuOpen((open) => !open);
  }

  return (
    <>
      <div
        className={`relative border-t border-zinc-200 bg-white ${
          collapsed ? "px-2 py-2" : "px-3 py-2"
        }`}
        ref={menuRef}
      >
        {menuOpen ? (
          <div
            className="fixed z-[100] min-w-44 rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg"
            role="menu"
            style={{
              bottom: menuPosition.bottom,
              left: menuPosition.left,
              width: MENU_WIDTH_PX,
            }}
          >
            <button
              aria-checked={theme === "dark"}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-zinc-100"
              type="button"
              role="menuitemcheckbox"
              onClick={toggleDarkMode}
            >
              <span className="flex items-center gap-2">
                {theme === "dark" ? (
                  <Sun aria-hidden className="h-4 w-4 text-zinc-500" />
                ) : (
                  <Moon aria-hidden className="h-4 w-4 text-zinc-500" />
                )}
                Dark Mode
              </span>
              <span className="text-xs text-zinc-500">
                {theme === "dark" ? "On" : "Off"}
              </span>
            </button>
            <div className="group/menu relative">
              <button
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-zinc-100"
                type="button"
                role="menuitem"
              >
                <span className="flex items-center gap-2">
                  <Info aria-hidden className="h-4 w-4 text-zinc-500" />
                  About
                </span>
                <ChevronRight aria-hidden className="h-4 w-4 text-zinc-400" />
              </button>
              <div
                className="absolute bottom-0 left-full hidden min-w-44 rounded-md border border-zinc-200 bg-white py-1 shadow-lg group-hover/menu:block group-focus-within/menu:block"
                role="menu"
              >
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-100"
                  type="button"
                  role="menuitem"
                  onClick={openAboutDialog}
                >
                  <Info aria-hidden className="h-4 w-4 text-zinc-500" />
                  About LiBERA
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <button
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="LiBERA menu"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-sm font-semibold text-zinc-950 hover:bg-zinc-100"
              title="LiBERA menu"
              type="button"
              onClick={toggleMenu}
            >
              L
            </button>
            <button
              aria-label="Logout"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-300 text-zinc-700 hover:bg-zinc-50 hover:text-zinc-950"
              title="Logout"
              type="button"
              onClick={() => void onLogout()}
            >
              <LogOut aria-hidden className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <button
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="min-w-0 rounded-md px-2 py-1.5 text-left text-sm font-semibold tracking-tight text-zinc-950 hover:bg-zinc-100"
              type="button"
              onClick={toggleMenu}
            >
              LiBERA
            </button>
            <button
              aria-label="Logout"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-300 text-zinc-700 hover:bg-zinc-50 hover:text-zinc-950"
              title="Logout"
              type="button"
              onClick={() => void onLogout()}
            >
              <LogOut aria-hidden className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      <AboutDialog open={aboutDialogOpen} onClose={() => setAboutDialogOpen(false)} />
    </>
  );
}
