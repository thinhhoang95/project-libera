import { LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { AboutDialog } from "@/components/libera/about-dialog";
import type { ThemePreference } from "@/lib/theme";
import { applyThemePreference } from "@/components/libera/theme-sync";

type SidebarAppMenuProps = {
  collapsed?: boolean;
  onLogout: () => Promise<void>;
};

function nativeMenuPointFromButton(button: HTMLElement) {
  const rect = button.getBoundingClientRect();

  return {
    x: Math.round(rect.left),
    y: Math.round(rect.bottom),
  };
}

export function SidebarAppMenu({
  collapsed = false,
  onLogout,
}: SidebarAppMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>("light");

  useEffect(() => {
    const syncTheme = () => {
      setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    };
    const animationFrame = window.requestAnimationFrame(syncTheme);
    window.addEventListener("libera:theme-changed", syncTheme);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("libera:theme-changed", syncTheme);
    };
  }, []);

  function openAboutDialog() {
    setMenuOpen(false);
    setAboutDialogOpen(true);
  }

  function toggleDarkMode() {
    const nextTheme = theme === "dark" ? "light" : "dark";

    applyThemePreference(nextTheme);
    setTheme(nextTheme);
    void apiRequest<{ theme: ThemePreference }>("/api/preferences/theme", {
      body: JSON.stringify({ theme: nextTheme }),
      method: "PATCH",
    }).catch(() => null);
  }

  async function openMenu(event: MouseEvent<HTMLButtonElement>) {
    const menu = window.liberaMenu;

    if (!menu) {
      return;
    }

    const point = nativeMenuPointFromButton(event.currentTarget);

    setMenuOpen(true);

    const selectedItemId = await menu
      .popup({
        ...point,
        items: [
          {
            id: "toggle-dark-mode",
            label: "Dark Mode",
            type: "checkbox",
            checked: theme === "dark",
          },
          { type: "separator" },
          { id: "about", label: "About LiBERA" },
        ],
      })
      .catch(() => null);

    setMenuOpen(false);

    if (selectedItemId === "toggle-dark-mode") {
      toggleDarkMode();
    } else if (selectedItemId === "about") {
      openAboutDialog();
    }
  }

  return (
    <>
      <div
        className={`libera-glass-chrome relative bg-card ${
          collapsed ? "py-2" : "px-3 py-2"
        }`}
      >
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <button
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="LiBERA menu"
              className="libera-sidebar-icon-button inline-flex h-9 w-9 items-center justify-center rounded-lg text-sm font-semibold"
              title="LiBERA menu"
              type="button"
              onClick={(event) => void openMenu(event)}
            >
              L
            </button>
            <button
              aria-label="Logout"
              className="libera-sidebar-icon-button inline-flex h-9 w-9 items-center justify-center rounded-lg"
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
              className="libera-sidebar-icon-button min-w-0 rounded-lg px-2 py-1.5 text-left text-sm font-semibold tracking-tight"
              type="button"
              onClick={(event) => void openMenu(event)}
            >
              LiBERA
            </button>
            <button
              aria-label="Logout"
              className="libera-sidebar-icon-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
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
