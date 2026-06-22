/* Main application layout 鈥?sidebar with nav + theme toggle + content area. */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  MessageCircle,
  Compass,
  LogOut,
  Menu,
  X,
  Settings,
  Sun,
  Moon,
  Users,
  Handshake,
  BarChart3,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { cn } from "@/lib/utils";
import { WebSocketProvider } from "@/providers/websocket-provider";
import { useAppStore } from "@/stores/app";
import { useThemeStore } from "@/stores/theme";
import { Button } from "@/components/ui/button";
import { PixelAvatar } from "@/components/ui/pixel-avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ProfileDialog } from "@/components/profile/profile-dialog";

interface NavItem {
  icon: typeof MessageCircle;
  label: string;
  path: string;
}

const NAV_ITEMS: NavItem[] = [
  { icon: BarChart3, label: "Reputation", path: "/reputation" },
  { icon: MessageCircle, label: "Chat", path: "/chat" },
  { icon: Compass, label: "Discover", path: "/discover" },
  { icon: Handshake, label: "Trade", path: "/trade" },
  { icon: Users, label: "My Entities", path: "/entities" },
];

function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn("brand-mark", className)} aria-label="Foundation Agents">
      <img src="/logo-black-1.png" alt="" className="brand-mark__image" />
    </div>
  );
}

export function MainLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const currentUser = useAppStore((s) => s.currentUser);
  const logout = useAppStore((s) => s.logout);
  const contactUnreadMap = useAppStore((s) => s.contactUnreadMap);
  const avatarCache = useAppStore((s) => s.avatarCache);
  const fetchAndCacheAvatar = useAppStore((s) => s.fetchAndCacheAvatar);
  const { theme, toggleTheme } = useThemeStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const currentAvatarSrc = currentUser ? avatarCache[currentUser.entity_uid] : undefined;
  const isReputationPage = location.pathname === "/reputation";

  const totalUnread = useMemo(
    () => Object.values(contactUnreadMap).reduce((sum, c) => sum + c.unread_count, 0),
    [contactUnreadMap],
  );

  useEffect(() => {
    if (currentUser && !currentAvatarSrc) {
      fetchAndCacheAvatar(currentUser.entity_uid);
    }
  }, [currentUser, currentAvatarSrc, fetchAndCacheAvatar]);

  function handleLogout() {
    logout();
    navigate("/");
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {/* --- Desktop Sidebar --- */}
      <aside className="hidden md:flex w-16 flex-col items-center border-r border-sidebar-border bg-sidebar py-4 gap-2">
        {/* Brand logo */}
        <BrandMark className="mb-3 h-8 w-8" />

        {/* Nav items with glow indicator */}
        <nav className="flex flex-col gap-1 flex-1">
          {NAV_ITEMS.map((item) => {
            const active = location.pathname === item.path;
            return (
              <Tooltip key={item.path}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => navigate(item.path)}
                    className={cn(
                      "relative flex items-center justify-center h-10 w-10 rounded-lg transition-all duration-200",
                      active
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-surface-hover",
                    )}
                  >
                    <item.icon className="h-5 w-5" />
                    {item.path === "/chat" && totalUnread > 0 && (
                      <span className="absolute top-1 right-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-sidebar" />
                    )}
                    {active && (
                      <motion.div
                        layoutId="sidebar-glow"
                        className="absolute -left-[9px] w-[3px] h-5 rounded-r-full bg-primary"
                        transition={{ type: "spring", stiffness: 400, damping: 30 }}
                      />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

        {/* Bottom actions */}
        <div className="flex flex-col items-center gap-1">
          {/* User avatar 鈥?clickable for profile */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setProfileOpen(true)}
                className="mb-1 group"
              >
                <PixelAvatar
                  name={currentUser?.name ?? "Human User"}
                  kind={currentUser?.kind ?? "human"}
                  src={currentAvatarSrc}
                  size="md"
                  className="transition-transform group-hover:scale-105"
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Edit Profile</TooltipContent>
          </Tooltip>

          {/* Theme toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={toggleTheme}
                className="flex items-center justify-center h-10 w-10 rounded-lg text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-all duration-200"
              >
                <AnimatePresence mode="wait">
                  {theme === "dark" ? (
                    <motion.div
                      key="sun"
                      initial={{ rotate: -90, opacity: 0, scale: 0.5 }}
                      animate={{ rotate: 0, opacity: 1, scale: 1 }}
                      exit={{ rotate: 90, opacity: 0, scale: 0.5 }}
                      transition={{ duration: 0.2 }}
                    >
                      <Sun className="h-5 w-5" />
                    </motion.div>
                  ) : (
                    <motion.div
                      key="moon"
                      initial={{ rotate: 90, opacity: 0, scale: 0.5 }}
                      animate={{ rotate: 0, opacity: 1, scale: 1 }}
                      exit={{ rotate: -90, opacity: 0, scale: 0.5 }}
                      transition={{ duration: 0.2 }}
                    >
                      <Moon className="h-5 w-5" />
                    </motion.div>
                  )}
                </AnimatePresence>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </TooltipContent>
          </Tooltip>

          {/* Logout */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleLogout}
                className="flex items-center justify-center h-10 w-10 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              >
                <LogOut className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Logout</TooltipContent>
          </Tooltip>
        </div>
      </aside>

      {/* --- Mobile Top Bar --- */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50 h-14 border-b border-border bg-background/80 backdrop-blur-xl flex items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
          <BrandMark className="h-7 w-7" />
          <span className="font-heading text-sm font-semibold">AI Office</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button onClick={() => setProfileOpen(true)}>
            <PixelAvatar
              name={currentUser?.name ?? "Human User"}
              kind={currentUser?.kind ?? "human"}
              src={currentAvatarSrc}
              size="sm"
            />
          </button>
        </div>
      </div>

      {/* --- Mobile Sidebar Overlay --- */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              initial={{ x: -256 }}
              animate={{ x: 0 }}
              exit={{ x: -256 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="md:hidden fixed left-0 top-14 bottom-0 z-40 w-64 bg-sidebar border-r border-sidebar-border p-4 flex flex-col"
            >
              <nav className="flex flex-col gap-1 flex-1">
                {NAV_ITEMS.map((item) => {
                  const active = location.pathname === item.path;
                  return (
                    <button
                      key={item.path}
                      onClick={() => {
                        navigate(item.path);
                        setMobileOpen(false);
                      }}
                      className={cn(
                        "relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors",
                        active
                          ? "bg-primary/15 text-primary"
                          : "text-muted-foreground hover:text-foreground hover:bg-surface-hover",
                      )}
                    >
                      {active && (
                        <motion.div
                          layoutId="mobile-sidebar-glow"
                          className="absolute left-0 w-[3px] h-5 rounded-r-full bg-primary"
                        />
                      )}
                      <item.icon className="h-5 w-5" />
                      {item.label}
                      {item.path === "/chat" && totalUnread > 0 && (
                        <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-medium text-white">
                          {totalUnread > 99 ? "99+" : totalUnread}
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>

              <div className="flex flex-col gap-1 pt-2 border-t border-sidebar-border">
                <button
                  onClick={() => {
                    setProfileOpen(true);
                    setMobileOpen(false);
                  }}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-colors"
                >
                  <Settings className="h-5 w-5" />
                  Settings
                </button>
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                >
                  <LogOut className="h-5 w-5" />
                  Logout
                </button>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* --- Content --- */}
      <main
        className={cn(
          "min-h-0 flex-1 md:pt-0 pt-14",
          isReputationPage ? "overflow-y-auto overflow-x-hidden" : "overflow-hidden",
        )}
      >
        <WebSocketProvider>{children}</WebSocketProvider>
      </main>

      {/* --- Profile Dialog --- */}
      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
    </div>
  );
}
