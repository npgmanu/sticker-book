"use client";

import { useMemo, useState } from "react";

type AdminUser = {
  email: string;
  displayName: string;
  onboardingCompleted: boolean;
  isDisabled: boolean;
  isAdmin: boolean;
  createdAt: string;
  updatedAt: string;
  activeSessions: number;
  collected: number;
  extras: number;
};

type ResetDetails = { email: string; resetCode: string; expiresAt: string };

function readableDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function AdminDashboard() {
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState("");
  const [busyEmail, setBusyEmail] = useState("");
  const [message, setMessage] = useState("");
  const [reset, setReset] = useState<ResetDetails | null>(null);

  const filteredUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? users.filter((user) => `${user.displayName} ${user.email}`.toLowerCase().includes(query)) : users;
  }, [search, users]);

  const disabledCount = users.filter((user) => user.isDisabled).length;
  const activeCount = users.filter((user) => !user.isDisabled).length;

  async function loadUsers(clearMessage = true) {
    if (clearMessage) setMessage("");
    const response = await fetch("/api/admin/users");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Admin dashboard could not be opened");
    setUsers(data.users ?? []);
  }

  async function showDashboard() {
    setOpen(true);
    try { await loadUsers(); } catch (error) { setMessage(error instanceof Error ? error.message : "Admin dashboard could not be opened"); }
  }

  async function runAction(user: AdminUser, action: "reset" | "signout" | "disable" | "enable" | "delete") {
    const labels = { reset: "create a password reset code for", signout: "sign out every device for", disable: "disable", enable: "restore", delete: "permanently delete" };
    if (["signout", "disable", "delete"].includes(action) && !window.confirm(`Are you sure you want to ${labels[action]} ${user.email}?`)) return;
    setBusyEmail(user.email);
    setMessage("");
    setReset(null);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: user.email, action }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Admin action failed");
      if (action === "reset") {
        setReset({ email: user.email, resetCode: data.resetCode, expiresAt: data.expiresAt });
        setMessage("One-time reset code created. It expires in 30 minutes.");
      } else {
        setMessage(action === "delete" ? `${user.email} was permanently removed.` : `${user.email} was updated.`);
      }
      await loadUsers(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Admin action failed");
    } finally {
      setBusyEmail("");
    }
  }

  async function copyResetCode() {
    if (!reset) return;
    try {
      await navigator.clipboard.writeText(reset.resetCode);
      setMessage("Reset code copied. Send it only to the account owner.");
    } catch {
      setMessage("Copy failed. Press and hold the code to copy it.");
    }
  }

  return (
    <>
      <button onClick={() => void showDashboard()}><span>◆</span><div><strong>Admin dashboard</strong><small>Manage Sticker Book accounts</small></div><b>›</b></button>
      {open && (
        <div className="admin-backdrop" role="presentation">
          <section className="admin-dashboard" role="dialog" aria-modal="true" aria-labelledby="admin-title">
            <header className="admin-header">
              <div><p>OWNER ACCESS</p><h1 id="admin-title">Admin Dashboard</h1></div>
              <button onClick={() => setOpen(false)} aria-label="Close admin dashboard">×</button>
            </header>
            <div className="admin-body">
              <div className="admin-summary">
                <div><strong>{users.length}</strong><span>Total accounts</span></div>
                <div><strong>{activeCount}</strong><span>Active</span></div>
                <div><strong>{disabledCount}</strong><span>Disabled</span></div>
              </div>
              <label className="admin-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or email" /></label>
              {reset && (
                <section className="reset-code-card">
                  <div><strong>Reset code for {reset.email}</strong><small>Expires {new Date(reset.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small></div>
                  <code>{reset.resetCode}</code>
                  <button onClick={() => void copyResetCode()}>Copy reset code</button>
                </section>
              )}
              {message && <p className="admin-message" role="status">{message}</p>}
              <div className="admin-user-list">
                {filteredUsers.map((user) => (
                  <article className={`admin-user-card ${user.isDisabled ? "is-disabled" : ""}`} key={user.email}>
                    <header>
                      <span className="admin-user-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
                      <div><strong>{user.displayName}</strong><small>{user.email}</small></div>
                      <b className={user.isDisabled ? "disabled" : "active"}>{user.isAdmin ? "OWNER" : user.isDisabled ? "DISABLED" : "ACTIVE"}</b>
                    </header>
                    <div className="admin-user-stats">
                      <span><strong>{user.collected}</strong> collected</span>
                      <span><strong>{user.extras}</strong> extras</span>
                      <span><strong>{user.activeSessions}</strong> sessions</span>
                    </div>
                    <p>Joined {readableDate(user.createdAt)}{!user.onboardingCompleted ? " · Setup not finished" : ""}</p>
                    {!user.isAdmin && (
                      <div className="admin-user-actions">
                        <button disabled={busyEmail === user.email} onClick={() => void runAction(user, "reset")}>Reset password</button>
                        <button disabled={busyEmail === user.email || user.isDisabled} onClick={() => void runAction(user, "signout")}>Sign out</button>
                        <button disabled={busyEmail === user.email} onClick={() => void runAction(user, user.isDisabled ? "enable" : "disable")}>{user.isDisabled ? "Restore" : "Disable"}</button>
                        <button className="delete-user" disabled={busyEmail === user.email} onClick={() => void runAction(user, "delete")}>Delete</button>
                      </div>
                    )}
                  </article>
                ))}
                {!filteredUsers.length && <p className="admin-empty">No accounts match your search.</p>}
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
