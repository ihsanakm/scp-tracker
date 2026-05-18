import { useState, useEffect, useCallback } from "react";
import { supabase, isSupabaseConfigured } from "./supabaseClient";

// --- Types & Interfaces ---
export interface Entry {
  id: string;
  location: string;
  initiative: string;
  activities: string;
  date: string;
  dateStarted: string;
  dateConcluded: string;
  male: string | number;
  female: string | number;
  newParticipants: string | number;
  repeatedParticipants: string | number;
  impact: string;
  nextStep: string;
  currentStatus: string;
  lastUpdated: string;
  submittedAt?: string;
}

const DEFAULT_LOCATIONS = [
  "Pulmoddai",
  "Arafanagar",
  "Mutur (Smart Ulama Project)",
  "Hambantota",
  "Malwanahinna",
];

const LEAD_PASSWORD = "SCP@2026";
const STATUS_OPTIONS = ["Planned", "In Progress", "Completed", "On Hold", "Cancelled"];
const DATA_KEY = "scp-tracker-v4-data";
const LOC_KEY = "scp-tracker-v4-locations";

const emptyEntry = (location = ""): Entry => ({
  id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
  location,
  initiative: "",
  activities: "",
  date: "",
  dateStarted: "",
  dateConcluded: "",
  male: "",
  female: "",
  newParticipants: "",
  repeatedParticipants: "",
  impact: "",
  nextStep: "",
  currentStatus: "Planned",
  lastUpdated: new Date().toISOString().slice(0, 10),
  submittedAt: new Date().toISOString(),
});

function generateCSV(entries: Entry[]) {
  const headers = [
    "SCP Location",
    "SCP Initiative",
    "Activities",
    "Date",
    "Date Started",
    "Date Concluded",
    "Current Status",
    "Last Updated",
    "Male",
    "Female",
    "Total Participants",
    "New Participants",
    "Repeated Participants",
    "Impact",
    "Next Step / Follow-up",
    "Submitted At",
  ];
  
  const esc = (v: any) => {
    const s = String(v != null ? v : "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };
  
  const rows = entries.map((e) => [
    e.location,
    e.initiative,
    e.activities,
    e.date || "",
    e.dateStarted,
    e.dateConcluded,
    e.currentStatus || "",
    e.lastUpdated || "",
    e.male || 0,
    e.female || 0,
    (parseInt(String(e.male)) || 0) + (parseInt(String(e.female)) || 0),
    e.newParticipants || 0,
    e.repeatedParticipants || 0,
    e.impact,
    e.nextStep,
    e.submittedAt ? new Date(e.submittedAt).toLocaleDateString() : "",
  ]);
  
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

function downloadCSV(entries: Entry[], filename: string) {
  const blob = new Blob([generateCSV(entries)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const stColor: Record<string, { bg: string; text: string; border: string }> = {
  "Planned": { bg: "rgba(99,102,241,0.12)", text: "#818cf8", border: "rgba(99,102,241,0.25)" },
  "In Progress": { bg: "rgba(56,201,162,0.12)", text: "#38c9a2", border: "rgba(56,201,162,0.25)" },
  "Completed": { bg: "rgba(34,197,94,0.12)", text: "#22c55e", border: "rgba(34,197,94,0.25)" },
  "On Hold": { bg: "rgba(245,166,35,0.12)", text: "#f5a623", border: "rgba(245,166,35,0.25)" },
  "Cancelled": { bg: "rgba(239,68,68,0.12)", text: "#ef4444", border: "rgba(239,68,68,0.25)" },
};

function Badge({ status }: { status: string }) {
  const c = stColor[status] || stColor["Planned"];
  return (
    <span
      className="badge-status"
      style={{
        background: c.bg,
        color: c.text,
        borderColor: c.border,
      }}
    >
      {status}
    </span>
  );
}

async function sLoad(key: string) {
  try {
    const win = window as any;
    if (win.storage) {
      const r = await win.storage.get(key, true);
      if (r && r.value) return JSON.parse(r.value);
    }
  } catch (e) {}
  try {
    const local = localStorage.getItem(key);
    if (local) return JSON.parse(local);
  } catch (e) {}
  return null;
}

async function sSave(key: string, data: any) {
  try {
    const win = window as any;
    if (win.storage) {
      await win.storage.set(key, JSON.stringify(data), true);
    }
  } catch (e) {}
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {}
}

export default function App() {
  const [locations, setLocations] = useState<string[]>(DEFAULT_LOCATIONS);
  const [role, setRole] = useState<"lead" | "location" | null>(null);
  const [userLocation, setUserLocation] = useState<string>("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [activeTab, setActiveTab] = useState<string>("entry");
  const [current, setCurrent] = useState<Entry>(emptyEntry());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filterLocation, setFilterLocation] = useState<string>("All");
  const [toast, setToast] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [pwInput, setPwInput] = useState<string>("");
  const [pwError, setPwError] = useState<boolean>(false);
  const [showPwScreen, setShowPwScreen] = useState<boolean>(false);
  const [newLocName, setNewLocName] = useState<string>("");

  useEffect(() => {
    const initData = async () => {
      // 1. Immediately load from localStorage cache for instant UI rendering & reliable offline-first fallback
      const localData = await sLoad(DATA_KEY);
      const localLocs = await sLoad(LOC_KEY);

      if (localData) setEntries(localData);
      if (localLocs && Array.isArray(localLocs) && localLocs.length > 0) {
        setLocations(localLocs);
      } else {
        setLocations(DEFAULT_LOCATIONS);
      }

      // 2. Fetch from Supabase in the background to sync with live data
      if (isSupabaseConfigured && supabase) {
        try {
          // Fetch entries from Supabase
          const { data: dbEntries, error: entriesError } = await supabase
            .from("entries")
            .select("*")
            .order("submittedAt", { ascending: true });

          if (entriesError) throw entriesError;

          // Fetch locations from Supabase
          const { data: dbLocs, error: locsError } = await supabase
            .from("locations")
            .select("name")
            .order("name", { ascending: true });

          if (locsError) throw locsError;

          if (dbEntries) {
            setEntries(dbEntries);
            await sSave(DATA_KEY, dbEntries);
          }
          
          if (dbLocs && dbLocs.length > 0) {
            const fetchedLocs = dbLocs.map((l: any) => l.name);
            setLocations(fetchedLocs);
            await sSave(LOC_KEY, fetchedLocs);
          } else {
            // Seed default locations if DB is empty
            const seedLocs = DEFAULT_LOCATIONS;
            await supabase.from("locations").insert(seedLocs.map(name => ({ name })));
            setLocations(seedLocs);
            await sSave(LOC_KEY, seedLocs);
          }
        } catch (err) {
          console.error("Error loading data from Supabase:", err);
          showToast("⚠️ DB sync failed. Running in offline/cached mode.");
          // Note: We leave the local state intact since it was already loaded from local cache!
        } finally {
          setLoading(false);
        }
      } else {
        setLoading(false);
      }
    };

    initData();
  }, []);

  const persistEntries = useCallback(async (d: Entry[]) => {
    await sSave(DATA_KEY, d);
  }, []);

  const persistLocations = useCallback(async (l: string[]) => {
    await sSave(LOC_KEY, l);
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2800);
  };

  const total = (e: Entry) => (parseInt(String(e.male)) || 0) + (parseInt(String(e.female)) || 0);
  const isLead = role === "lead";

  const handleLeadLogin = () => {
    if (pwInput === LEAD_PASSWORD) {
      setRole("lead");
      setUserLocation("");
      setActiveTab("dashboard");
      setShowPwScreen(false);
      setPwInput("");
      setPwError(false);
    } else {
      setPwError(true);
    }
  };

  const handleLocationLogin = (loc: string) => {
    setRole("location");
    setUserLocation(loc);
    setCurrent(emptyEntry(loc));
    setActiveTab("dashboard");
  };

  const handleLogout = () => {
    setRole(null);
    setUserLocation("");
    setEditingId(null);
    setCurrent(emptyEntry());
    setShowPwScreen(false);
    setPwInput("");
    setPwError(false);
    setActiveTab("entry");
  };

  const myEntries = entries.filter((e) => e.location === userLocation);
  const visibleEntries = isLead ? entries : myEntries;
  const filteredEntries =
    filterLocation === "All"
      ? visibleEntries
      : visibleEntries.filter((e) => e.location === filterLocation);

  /* ═══ SAVE (create or update) ═══ */
  const handleSave = async () => {
    if (!current.location || !current.initiative) {
      showToast("⚠️ Location and Initiative are required");
      return;
    }
    const now = new Date().toISOString().slice(0, 10);
    const itemToSave = {
      ...current,
      lastUpdated: now,
      submittedAt: current.submittedAt || new Date().toISOString(),
      male: parseInt(String(current.male)) || 0,
      female: parseInt(String(current.female)) || 0,
      newParticipants: parseInt(String(current.newParticipants)) || 0,
      repeatedParticipants: parseInt(String(current.repeatedParticipants)) || 0,
    };

    let updated: Entry[];
    if (editingId) {
      updated = entries.map((e) => e.id === editingId ? itemToSave : e);
      setEditingId(null);
      showToast("✅ Entry updated — " + current.initiative);
      setActiveTab("records");
    } else {
      updated = [...entries, itemToSave];
      showToast("✅ Entry saved");
    }

    // Always update local state and local storage first for durability and offline safety
    setEntries(updated);
    await persistEntries(updated);
    setCurrent(emptyEntry(isLead ? current.location : userLocation));

    if (isSupabaseConfigured && supabase) {
      try {
        const { error } = await supabase
          .from("entries")
          .upsert(itemToSave);

        if (error) throw error;
        showToast("✅ Synced to cloud database");
      } catch (err: any) {
        console.error("Save error:", err);
        showToast("⚠️ Saved locally. Cloud sync failed: " + err.message);
      }
    }
  };

  /* ═══ EDIT — loads entry into form ═══ */
  const handleEdit = (entry: Entry) => {
    setCurrent({ ...emptyEntry(entry.location), ...entry });
    setEditingId(entry.id);
    setActiveTab("entry");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /* ═══ CANCEL EDIT ═══ */
  const cancelEdit = () => {
    setEditingId(null);
    setCurrent(emptyEntry(isLead ? locations[0] : userLocation));
  };

  const handleDelete = async (id: string) => {
    const updated = entries.filter((e) => e.id !== id);

    // Always update local state and local storage first
    setEntries(updated);
    await persistEntries(updated);
    if (editingId === id) cancelEdit();
    showToast("🗑️ Entry deleted");

    if (isSupabaseConfigured && supabase) {
      try {
        const { error } = await supabase
          .from("entries")
          .delete()
          .eq("id", id);

        if (error) throw error;
        showToast("🗑️ Entry deleted and synced to cloud");
      } catch (err: any) {
        console.error("Delete error:", err);
        showToast("⚠️ Deleted locally. Cloud sync failed: " + err.message);
      }
    }
  };

  const handleDownload = () => {
    const data = filterLocation === "All" ? visibleEntries : filteredEntries;
    const tag =
      filterLocation === "All"
        ? isLead
          ? "All_Locations"
          : userLocation.replace(/[^a-zA-Z0-9]/g, "_")
        : filterLocation.replace(/[^a-zA-Z0-9]/g, "_");
    downloadCSV(
      data,
      "SCP_Report_" + tag + "_" + new Date().toISOString().slice(0, 10) + ".csv"
    );
    showToast("📥 Report downloaded");
  };

  const addLocation = async () => {
    const name = newLocName.trim();
    if (!name) return;
    if (locations.includes(name)) {
      showToast("⚠️ Location already exists");
      return;
    }

    const updated = [...locations, name];

    // Always update local state and local storage first for durability and offline safety
    setLocations(updated);
    await persistLocations(updated);
    setNewLocName("");

    if (isSupabaseConfigured && supabase) {
      try {
        const { error } = await supabase
          .from("locations")
          .insert({ name });

        if (error) throw error;
        showToast("✅ " + name + " added and synced to cloud");
      } catch (err: any) {
        console.error("Add location error:", err);
        showToast("⚠️ Added locally. Cloud sync failed: " + err.message);
      }
    } else {
      showToast("✅ " + name + " added locally");
    }
  };

  const removeLocation = async (loc: string) => {
    if (entries.some((e) => e.location === loc)) {
      showToast("⚠️ Can't remove — has entries");
      return;
    }

    const updated = locations.filter((l) => l !== loc);

    // Always update local state and local storage first
    setLocations(updated);
    await persistLocations(updated);

    if (isSupabaseConfigured && supabase) {
      try {
        const { error } = await supabase
          .from("locations")
          .delete()
          .eq("name", loc);

        if (error) throw error;
        showToast("🗑️ " + loc + " removed and synced to cloud");
      } catch (err: any) {
        console.error("Remove location error:", err);
        showToast("⚠️ Removed locally. Cloud sync failed: " + err.message);
      }
    } else {
      showToast("🗑️ " + loc + " removed locally");
    }
  };

  const buildSummary = (locList: string[], entryList: Entry[]) =>
    locList.map((loc) => {
      const le = entryList.filter((e) => e.location === loc);
      return {
        location: loc,
        count: le.length,
        male: le.reduce((s, e) => s + (parseInt(String(e.male)) || 0), 0),
        female: le.reduce((s, e) => s + (parseInt(String(e.female)) || 0), 0),
        newP: le.reduce((s, e) => s + (parseInt(String(e.newParticipants)) || 0), 0),
        repP: le.reduce((s, e) => s + (parseInt(String(e.repeatedParticipants)) || 0), 0),
        statuses: STATUS_OPTIONS.map((st) => ({
          status: st,
          count: le.filter((x) => x.currentStatus === st).length,
        })).filter((x) => x.count > 0),
      };
    });

  const grandTotals = (list: Entry[]) => ({
    count: list.length,
    male: list.reduce((s, e) => s + (parseInt(String(e.male)) || 0), 0),
    female: list.reduce((s, e) => s + (parseInt(String(e.female)) || 0), 0),
    newP: list.reduce((s, e) => s + (parseInt(String(e.newParticipants)) || 0), 0),
    repP: list.reduce((s, e) => s + (parseInt(String(e.repeatedParticipants)) || 0), 0),
  });

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        <div style={{ width: 42, height: 42, border: "4px solid rgba(99,102,241,0.15)", borderTopColor: "#6366f1", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
        <p style={{ color: "#6b7c96", marginTop: 20, fontWeight: 500, letterSpacing: "0.5px" }}>Booting Intelligence Console...</p>
      </div>
    );
  }

  /* ═══ LOGIN ═══ */
  if (!role) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div className="premium-card" style={{ width: "100%", maxWidth: 430, padding: 36, animation: "fadeUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 26 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: "linear-gradient(135deg,#6366f1,#10b981)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 16, color: "#fff", boxShadow: "0 4px 20px rgba(99,102,241,0.25)" }}>
              SCP
            </div>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 800, color: "var(--text-title)", letterSpacing: "-0.3px", margin: 0 }}>SCP Activity Tracker</h1>
              <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase" }}>Version 4.0 Pro</span>
            </div>
          </div>

          {!showPwScreen ? (
            <>
              <button
                className="btn btn-outline"
                onClick={() => setShowPwScreen(true)}
                style={{ width: "100%", padding: "16px", borderRadius: 12, justifyContent: "flex-start", gap: 14, background: "linear-gradient(135deg,rgba(99,102,241,0.06),rgba(16,185,129,0.03))", borderColor: "rgba(99,102,241,0.15)" }}
              >
                <span style={{ fontSize: 22 }}>🛡️</span>
                <div style={{ textAlign: "left" }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text-title)" }}>Programme Lead</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>Secure access • Master dashboard</div>
                </div>
              </button>

              <div style={{ fontSize: 11, color: "var(--text-muted)", margin: "24px 0 12px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1.2px", borderBottom: "1px solid rgba(255,255,255,0.05)", paddingBottom: 6 }}>
                Location Teams
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8, maxHeight: 220, overflowY: "auto", paddingRight: 4 }}>
                {locations.map((loc) => (
                  <button
                    key={loc}
                    className="btn btn-outline"
                    onClick={() => handleLocationLogin(loc)}
                    style={{ width: "100%", padding: "12px 14px", justifyContent: "space-between" }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 16 }}>📍</span>
                      <span style={{ fontWeight: 600 }}>{loc}</span>
                    </span>
                    <span style={{ fontSize: 12, opacity: 0.5 }}>→</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div style={{ animation: "fadeUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)" }}>
              <button
                onClick={() => {
                  setShowPwScreen(false);
                  setPwError(false);
                  setPwInput("");
                }}
                className="btn btn-outline"
                style={{ padding: "6px 12px", fontSize: 12, marginBottom: 20 }}
              >
                ← Back
              </button>
              
              <div style={{ textAlign: "center", marginBottom: 24 }}>
                <div style={{ fontSize: 44, marginBottom: 10 }}>🔒</div>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-title)" }}>Programme Lead Verification</h3>
                <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>Enter administrator password to continue</p>
              </div>

              <input
                type="password"
                value={pwInput}
                onChange={(e) => {
                  setPwInput(e.target.value);
                  setPwError(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleLeadLogin();
                }}
                placeholder="••••••••"
                className="input-field"
                style={{ textAlign: "center", fontSize: 18, letterSpacing: "4px", marginBottom: 12, borderColor: pwError ? "rgba(239,68,68,0.5)" : "var(--border-color)" }}
                autoFocus
              />

              {pwError && (
                <div style={{ color: "var(--danger)", fontSize: 12, textAlign: "center", marginBottom: 14, fontWeight: 600 }}>
                  ⚠️ Invalid credentials. Access denied.
                </div>
              )}

              <button
                className="btn btn-primary"
                onClick={handleLeadLogin}
                style={{ width: "100%", padding: "13px" }}
              >
                Verify and Unlock
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ═══ MAIN APP ═══ */
  const tabs = isLead
    ? [
        { key: "dashboard", label: "Dashboard", icon: "📊" },
        { key: "records", label: "All Records", icon: "📋" },
        { key: "entry", label: editingId ? "Editing" : "Add Entry", icon: editingId ? "✏️" : "➕" },
        { key: "settings", label: "Settings", icon: "⚙️" },
      ]
    : [
        { key: "dashboard", label: "My Dashboard", icon: "📊" },
        { key: "entry", label: editingId ? "Editing" : "New Entry", icon: editingId ? "✏️" : "➕" },
        { key: "records", label: "My Records", icon: "📋" },
      ];

  const summaryData = isLead
    ? buildSummary(locations, entries)
    : buildSummary([userLocation], entries);
  const grand = grandTotals(isLead ? entries : myEntries);

  const renderEntryCard = (entry: Entry, compact: boolean) => {
    const canEdit = isLead || entry.location === userLocation;
    const isBeingEdited = editingId === entry.id;
    return (
      <div
        key={entry.id}
        className={`entry-card ${isBeingEdited ? "editing-active" : ""}`}
        style={{ transition: "all 0.25s cubic-bezier(0.16, 1, 0.3, 1)" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10.5, color: "#818cf8", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.8px" }}>
                📍 {entry.location}
              </span>
              <Badge status={entry.currentStatus} />
              {isBeingEdited && (
                <span style={{ fontSize: 9.5, padding: "2px 8px", borderRadius: 4, background: "rgba(245,158,11,0.15)", color: "var(--accent)", fontWeight: 800, border: "1px solid rgba(245,158,11,0.25)", letterSpacing: "0.5px" }}>
                  EDITING STATE
                </span>
              )}
            </div>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-title)", marginTop: 6, letterSpacing: "-0.1px" }}>
              {entry.initiative}
            </h3>
          </div>
          {canEdit && (
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button
                className="btn btn-outline"
                onClick={() => handleEdit(entry)}
                style={{ padding: "6px 12px", fontSize: 12 }}
                title="Edit entry"
              >
                ✏️ Edit
              </button>
              <button
                className="btn btn-danger"
                onClick={() => handleDelete(entry.id)}
                style={{ padding: "6px 10px", fontSize: 12 }}
                title="Delete entry"
              >
                🗑️
              </button>
            </div>
          )}
        </div>

        {!compact && entry.activities && (
          <p style={{ fontSize: 13.5, color: "#9caac2", margin: "12px 0 14px", lineHeight: 1.6, background: "rgba(255,255,255,0.01)", padding: "10px 12px", borderRadius: 8, borderLeft: "2px solid rgba(99, 102, 241, 0.3)" }}>
            {entry.activities}
          </p>
        )}

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11.5, color: "var(--text-muted)", marginTop: 10, fontFamily: "var(--font-mono)" }}>
          {entry.date && <span>📅 {entry.date}</span>}
          {entry.dateStarted && <span>🟢 Start: {entry.dateStarted}</span>}
          {entry.dateConcluded && <span>🔴 End: {entry.dateConcluded}</span>}
          <span>
            👤 M:{entry.male || 0} F:{entry.female || 0} ={" "}
            <strong style={{ color: "var(--secondary)", fontWeight: 700 }}>
              {total(entry)}
            </strong>
          </span>
          <span>🆕 New: {entry.newParticipants || 0} | Rep: {entry.repeatedParticipants || 0}</span>
          {entry.lastUpdated && <span style={{ opacity: 0.7 }}>🕐 Sync: {entry.lastUpdated}</span>}
        </div>

        {!compact && (entry.impact || entry.nextStep) && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.04)", fontSize: 12.5, color: "var(--text-main)", display: "flex", flexDirection: "column", gap: 6 }}>
            {entry.impact && (
              <div>
                <strong style={{ color: "#a5b4fc" }}>Impact Outcome:</strong> {entry.impact}
              </div>
            )}
            {entry.nextStep && (
              <div>
                <strong style={{ color: "#a5b4fc" }}>Next Actionable Steps:</strong> {entry.nextStep}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ minHeight: "100vh", paddingBottom: 60 }}>
      {toast && (
        <div
          style={{
            position: "fixed",
            top: 20,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(10, 20, 42, 0.95)",
            color: "var(--secondary)",
            padding: "12px 28px",
            borderRadius: 12,
            fontSize: 14,
            fontWeight: 700,
            zIndex: 1000,
            border: "1px solid rgba(16, 185, 129, 0.3)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.4), 0 0 15px rgba(16, 185, 129, 0.1)",
            animation: "slideDown 0.35s cubic-bezier(0.16, 1, 0.3, 1)",
            backdropFilter: "blur(10px)",
          }}
        >
          {toast}
        </div>
      )}

      {/* Header Bar */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", borderBottom: "1px solid rgba(255,255,255,0.04)", background: "rgba(6, 9, 19, 0.6)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg,var(--primary),var(--secondary))", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 13, color: "#fff", boxShadow: "0 4px 15px var(--primary-glow)" }}>
            SCP
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text-title)", letterSpacing: "-0.2px" }}>SCP Intelligence Hub</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>
              {isLead ? "🛡️ Programme Director Console" : "📍 Location: " + userLocation}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              padding: "4px 10px",
              borderRadius: 20,
              background: isSupabaseConfigured ? "rgba(16,185,129,0.12)" : "rgba(245,158,11,0.12)",
              color: isSupabaseConfigured ? "#10b981" : "#f5a623",
              border: `1px solid ${isSupabaseConfigured ? "rgba(16,185,129,0.25)" : "rgba(245,158,11,0.25)"}`,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              textTransform: "uppercase",
              letterSpacing: "0.5px"
            }}
          >
            <span 
              style={{ 
                width: 6, 
                height: 6, 
                borderRadius: "50%", 
                background: isSupabaseConfigured ? "#10b981" : "#f5a623", 
                display: "inline-block", 
                animation: "pulse 1.8s infinite" 
              }} 
            />
            {isSupabaseConfigured ? "⚡ Cloud DB Connected" : "⚠️ Local Sandbox"}
          </span>
          <button
            className="btn btn-outline"
            onClick={handleLogout}
            style={{ padding: "6px 14px", fontSize: 12 }}
          >
            🔓 Exit Session
          </button>
        </div>
      </header>

      {/* Main Navigation Tabs */}
      <div className="tab-container">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`tab-btn ${activeTab === t.key ? "active" : ""} ${activeTab === t.key && t.key === "entry" && editingId ? "editing" : ""}`}
            onClick={() => setActiveTab(t.key)}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <main className="container">
        {/* ═══ DASHBOARD ═══ */}
        {activeTab === "dashboard" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Grand Stat Cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
              {[
                { label: "Total Initiatives", val: grand.count, color: "#818cf8" },
                { label: "Total Reached", val: grand.male + grand.female, color: "#34d399" },
                { label: "Male Participants", val: grand.male, color: "#60a5fa" },
                { label: "Female Participants", val: grand.female, color: "#f472b6" },
                { label: "New Reached", val: grand.newP, color: "#fbbf24" },
              ].map((c) => (
                <div key={c.label} className="premium-card" style={{ padding: "18px 14px", textAlign: "center" }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: c.color, fontFamily: "var(--font-mono)" }}>
                    {c.val}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                    {c.label}
                  </div>
                </div>
              ))}
            </div>

            {/* Status Breakdown Widgets */}
            <div className="premium-card">
              <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-title)", marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Active Initiative Status Breakdown
              </h2>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {STATUS_OPTIONS.map((st) => {
                  const count = visibleEntries.filter((e) => e.currentStatus === st).length;
                  const sc = stColor[st];
                  return (
                    <div
                      key={st}
                      style={{
                        background: sc.bg,
                        border: "1px solid " + sc.border,
                        borderRadius: 10,
                        padding: "10px 18px",
                        textAlign: "center",
                        minWidth: 95,
                        flex: 1,
                      }}
                    >
                      <div style={{ fontSize: 20, fontWeight: 800, color: sc.text, fontFamily: "var(--font-mono)" }}>
                        {count}
                      </div>
                      <div style={{ fontSize: 10, color: sc.text, fontWeight: 700, marginTop: 4, textTransform: "uppercase" }}>
                        {st}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Tabular Analysis Card */}
            <div className="premium-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
                <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-title)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  {isLead ? "Regional Summaries" : userLocation + " Operational Summary"}
                </h2>
                <button className="btn btn-success" onClick={handleDownload} style={{ padding: "8px 16px", fontSize: 12 }}>
                  📥 Export Dataset
                </button>
              </div>

              <div style={{ overflowX: "auto" }}>
                <table className="summary-table">
                  <thead>
                    <tr>
                      {["Location", "Initiatives", "Male", "Female", "Aggregate", "New Reach", "Repeated", "Status"].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {summaryData.map((r) => (
                      <tr key={r.location}>
                        <td style={{ fontWeight: 700, color: "var(--text-title)" }}>{r.location}</td>
                        <td style={{ fontWeight: 700, color: "var(--primary)", fontFamily: "var(--font-mono)" }}>{r.count}</td>
                        <td style={{ fontFamily: "var(--font-mono)" }}>{r.male}</td>
                        <td style={{ fontFamily: "var(--font-mono)" }}>{r.female}</td>
                        <td style={{ fontWeight: 700, color: "var(--secondary)", fontFamily: "var(--font-mono)" }}>{r.male + r.female}</td>
                        <td style={{ fontFamily: "var(--font-mono)" }}>{r.newP}</td>
                        <td style={{ fontFamily: "var(--font-mono)" }}>{r.repP}</td>
                        <td>
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {r.statuses.map((s) => (
                              <span
                                key={s.status}
                                style={{
                                  fontSize: 9.5,
                                  padding: "2px 6px",
                                  borderRadius: 4,
                                  background: stColor[s.status].bg,
                                  color: stColor[s.status].text,
                                  fontWeight: 800,
                                }}
                              >
                                {s.count} {s.status}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {isLead && (
                      <tr style={{ borderTop: "2px solid rgba(99, 102, 241, 0.25)", background: "rgba(99, 102, 241, 0.05)" }}>
                        <td style={{ fontWeight: 800, color: "#818cf8" }}>TOTAL</td>
                        <td style={{ fontWeight: 800, color: "#818cf8", fontFamily: "var(--font-mono)" }}>{grand.count}</td>
                        <td style={{ fontWeight: 700, fontFamily: "var(--font-mono)" }}>{grand.male}</td>
                        <td style={{ fontWeight: 700, fontFamily: "var(--font-mono)" }}>{grand.female}</td>
                        <td style={{ fontWeight: 800, color: "var(--secondary)", fontFamily: "var(--font-mono)" }}>{grand.male + grand.female}</td>
                        <td style={{ fontWeight: 700, fontFamily: "var(--font-mono)" }}>{grand.newP}</td>
                        <td style={{ fontWeight: 700, fontFamily: "var(--font-mono)" }}>{grand.repP}</td>
                        <td></td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Recent Entries */}
            {visibleEntries.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--text-title)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  Recent Stream Syncs
                </h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {visibleEntries
                    .slice(-5)
                    .reverse()
                    .map((entry) => renderEntryCard(entry, true))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ RECORDS ═══ */}
        {activeTab === "records" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              {isLead && (
                <select
                  value={filterLocation}
                  onChange={(e) => setFilterLocation(e.target.value)}
                  className="input-field"
                  style={{ maxWidth: 220, cursor: "pointer", appearance: "auto" }}
                >
                  <option value="All">All Regions</option>
                  {locations.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              )}
              <span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 500 }}>
                {filteredEntries.length} operational record{filteredEntries.length !== 1 ? "s" : ""} located
              </span>
              {filteredEntries.length > 0 && (
                <button
                  onClick={handleDownload}
                  className="btn btn-outline"
                  style={{ marginLeft: "auto", padding: "8px 16px", fontSize: 12 }}
                >
                  📥 Export CSV
                </button>
              )}
            </div>

            {filteredEntries.length === 0 ? (
              <div className="premium-card" style={{ textAlign: "center", padding: "60px 20px" }}>
                <div style={{ fontSize: 44, marginBottom: 14 }}>📭</div>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-title)" }}>No Records Found</h3>
                <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>This regional vector does not contain any synced streams.</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {filteredEntries.map((entry) => renderEntryCard(entry, false))}
              </div>
            )}
          </div>
        )}

        {/* ═══ ENTRY FORM ═══ */}
        {activeTab === "entry" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Editing mode banner */}
            {editingId && (
              <div
                className="premium-card"
                style={{
                  background: "linear-gradient(135deg, rgba(245,158,11,0.08), rgba(245,158,11,0.03))",
                  borderColor: "rgba(245,158,11,0.3)",
                  padding: "16px 20px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--accent)" }}>
                    ✏️ Editing initiative: {current.initiative || "Unnamed Stream"}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    Active node: {current.location} • Modify the vectors below and click save.
                  </div>
                </div>
                <button
                  onClick={cancelEdit}
                  className="btn btn-outline"
                  style={{ padding: "6px 14px", fontSize: 12, borderColor: "rgba(245,158,11,0.3)", color: "var(--accent)" }}
                >
                  ✕ Cancel Operations
                </button>
              </div>
            )}

            <div className="premium-card" style={{ borderColor: editingId ? "rgba(245,158,11,0.2)" : "var(--border-color)" }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: editingId ? "var(--accent)" : "var(--text-title)", margin: 0, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                {editingId ? "Modify Synced Dataset" : "Initialize Activity Vector"}
              </h2>
              {!editingId && (
                <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                  Input operational stream parameters to register standard activity metrics.
                </p>
              )}

              <label className="input-label">SCP Regional Node</label>
              {!isLead ? (
                <div
                  style={{
                    padding: "12px 14px",
                    borderRadius: 10,
                    background: "rgba(99,102,241,0.05)",
                    color: "#818cf8",
                    fontSize: 14,
                    fontWeight: 700,
                    border: "1px solid rgba(99,102,241,0.15)",
                  }}
                >
                  📍 {userLocation}
                </div>
              ) : (
                
                <select
                  value={current.location}
                  onChange={(e) => setCurrent({ ...current, location: e.target.value })}
                  className="input-field"
                  style={{ cursor: "pointer", appearance: "auto" }}
                >
                  <option value="" disabled>Select Location Node...</option>
                  {locations.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              )}

              <label className="input-label">SCP Initiative / Program Name *</label>
              <input
                value={current.initiative}
                onChange={(e) => setCurrent({ ...current, initiative: e.target.value })}
                placeholder="e.g. Next-Gen Youth Leadership Seminar"
                className="input-field"
              />

              <label className="input-label">Operational Activities & Curriculum</label>
              <textarea
                value={current.activities}
                onChange={(e) => setCurrent({ ...current, activities: e.target.value })}
                placeholder="Detail curriculum components, session metrics, and deliverables..."
                rows={4}
                className="input-field"
                style={{ resize: "vertical", minHeight: 90 }}
              />

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12 }}>
                <div>
                  <label className="input-label">Core Target Date</label>
                  <input
                    type="date"
                    value={current.date}
                    onChange={(e) => setCurrent({ ...current, date: e.target.value })}
                    className="input-field"
                  />
                </div>
                <div>
                  <label className="input-label">Date Commenced</label>
                  <input
                    type="date"
                    value={current.dateStarted}
                    onChange={(e) => setCurrent({ ...current, dateStarted: e.target.value })}
                    className="input-field"
                  />
                </div>
                <div>
                  <label className="input-label">Date Concluded</label>
                  <input
                    type="date"
                    value={current.dateConcluded}
                    onChange={(e) => setCurrent({ ...current, dateConcluded: e.target.value })}
                    className="input-field"
                  />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label className="input-label">Current Status Vector</label>
                  <select
                    value={current.currentStatus}
                    onChange={(e) => setCurrent({ ...current, currentStatus: e.target.value })}
                    className="input-field"
                    style={{ cursor: "pointer", appearance: "auto" }}
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="input-label">Last Sync Audit</label>
                  <input
                    type="date"
                    value={current.lastUpdated}
                    onChange={(e) => setCurrent({ ...current, lastUpdated: e.target.value })}
                    className="input-field"
                  />
                </div>
              </div>

              {/* Participants Metrics Group */}
              <div
                style={{
                  background: "rgba(99,102,241,0.02)",
                  borderRadius: 12,
                  padding: 20,
                  marginTop: 22,
                  border: "1px solid rgba(99, 102, 241, 0.08)",
                }}
              >
                <div style={{ fontSize: 13, color: "#818cf8", fontWeight: 700, marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  👥 Target Participant Vectors
                </div>
                
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <label className="input-label" style={{ marginTop: 0 }}>Male Participants</label>
                    <input
                      type="number"
                      min="0"
                      value={current.male}
                      onChange={(e) => setCurrent({ ...current, male: e.target.value })}
                      placeholder="0"
                      className="input-field"
                    />
                  </div>
                  <div>
                    <label className="input-label" style={{ marginTop: 0 }}>Female Participants</label>
                    <input
                      type="number"
                      min="0"
                      value={current.female}
                      onChange={(e) => setCurrent({ ...current, female: e.target.value })}
                      placeholder="0"
                      className="input-field"
                    />
                  </div>
                  <div>
                    <label className="input-label" style={{ marginTop: 0 }}>Unique Reach (New)</label>
                    <input
                      type="number"
                      min="0"
                      value={current.newParticipants}
                      onChange={(e) => setCurrent({ ...current, newParticipants: e.target.value })}
                      placeholder="0"
                      className="input-field"
                    />
                  </div>
                  <div>
                    <label className="input-label" style={{ marginTop: 0 }}>Recurrent Reach (Repeat)</label>
                    <input
                      type="number"
                      min="0"
                      value={current.repeatedParticipants}
                      onChange={(e) => setCurrent({ ...current, repeatedParticipants: e.target.value })}
                      placeholder="0"
                      className="input-field"
                    />
                  </div>
                </div>

                {(current.male || current.female) && (
                  <div
                    style={{
                      marginTop: 14,
                      padding: "10px 14px",
                      background: "rgba(16,185,129,0.06)",
                      borderRadius: 8,
                      fontSize: 13,
                      color: "var(--secondary)",
                      fontWeight: 600,
                      border: "1px solid rgba(16,185,129,0.15)",
                    }}
                  >
                    Aggregated Metrics Reached:{" "}
                    <strong style={{ fontSize: 14 }}>{total(current)}</strong> active individuals.
                  </div>
                )}
              </div>

              <label className="input-label">Programmatic Impact & Outcomes</label>
              <textarea
                value={current.impact}
                onChange={(e) => setCurrent({ ...current, impact: e.target.value })}
                placeholder="Identify systemic transformations, quantitative indicators, or direct qualitative changes observed..."
                rows={2}
                className="input-field"
                style={{ resize: "vertical" }}
              />

              <label className="input-label">Next Actionable Step / Follow-up Protocol</label>
              <textarea
                value={current.nextStep}
                onChange={(e) => setCurrent({ ...current, nextStep: e.target.value })}
                placeholder="Identify milestones, subsequent evaluations, or direct logistical actions scheduled next..."
                rows={2}
                className="input-field"
                style={{ resize: "vertical" }}
              />

              <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
                <button
                  onClick={handleSave}
                  className={`btn ${editingId ? "btn-accent" : "btn-primary"}`}
                  style={{ flex: 1, padding: "13px" }}
                >
                  {editingId ? "💾 Commit Database Changes" : "Register Activity Stream"}
                </button>
                {editingId && (
                  <button
                    onClick={cancelEdit}
                    className="btn btn-outline"
                    style={{ padding: "13px 22px" }}
                  >
                    Discard Edits
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ═══ SETTINGS ═══ */}
        {activeTab === "settings" && isLead && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="premium-card">
              <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-title)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                ⚙️ Node Network Operations
              </h2>
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4, marginBottom: 18 }}>
                Maintain the regional workspace map by registering new operational vectors. Existing nodes containing active records cannot be deleted.
              </p>
              
              <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
                <input
                  value={newLocName}
                  onChange={(e) => setNewLocName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addLocation();
                  }}
                  placeholder="e.g. Trincomalee Hub"
                  className="input-field"
                  style={{ flex: 1 }}
                />
                <button
                  onClick={addLocation}
                  className="btn btn-primary"
                  style={{ padding: "12px 24px" }}
                >
                  + Add Vector
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {locations.map((loc) => {
                  const count = entries.filter((e) => e.location === loc).length;
                  return (
                    <div
                      key={loc}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "14px 18px",
                        background: "rgba(255,255,255,0.015)",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.03)",
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-title)" }}>
                          📍 {loc}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                          {count} activity stream{count === 1 ? "" : "s"} logged
                        </div>
                      </div>
                      {count === 0 ? (
                        <button
                          onClick={() => removeLocation(loc)}
                          className="btn btn-danger"
                          style={{ padding: "6px 12px", fontSize: 11.5 }}
                        >
                          Decommission Node
                        </button>
                      ) : (
                        <span style={{ fontSize: 11.5, color: "var(--text-muted)", fontStyle: "italic", fontFamily: "var(--font-mono)" }}>
                          🔒 Active System Node
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
