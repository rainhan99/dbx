import { createPinia, setActivePinia } from "pinia";
import { computed, nextTick, ref, watch } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTunnelProfile } from "@/lib/connection/tunnelProfiles";
import type { TunnelProfile } from "@/types/database";

/**
 * Adversarial reproduction for the reported tunnel-profile issues:
 *
 *   #1  Settings > Tunnels shows an empty list after saving and reopening.
 *   #2  A new connection's tunnel dropdown can't select a configured profile.
 *
 * This repo has no @vue/test-utils / DOM harness, so instead of rendering the
 * components we drive the *real* `tunnelProfileStore` against an in-memory
 * "disk" and mirror the exact draft-seeding lifecycle that lives in
 * `TunnelProfileManager.vue`. The mirror is a faithful copy of that setup code
 * — if the component's watcher changes, these expectations must change too.
 */

// In-memory backend "disk" shared by the mocked api. Cleared per test.
const disk: { profiles: TunnelProfile[] } = vi.hoisted(() => ({ profiles: [] })) as { profiles: TunnelProfile[] };

const clone = (p: TunnelProfile[]): TunnelProfile[] => JSON.parse(JSON.stringify(p));

vi.mock("@/lib/backend/api", () => ({
  loadTunnelProfiles: vi.fn(async () => clone(disk.profiles)),
  saveTunnelProfiles: vi.fn(async (profiles: TunnelProfile[]) => {
    // Mirrors storage.save_tunnel_profiles: DELETE-all then re-INSERT, i.e. the
    // saved list *replaces* the whole catalog. This is why saving a stale draft
    // wipes previously-persisted profiles.
    disk.profiles = clone(profiles);
  }),
  testTunnelProfile: vi.fn(async () => "SSH tunnel connection successful"),
}));

// Imported after the mock so the store binds to the mocked api.
const { useTunnelProfileStore } = await import("@/stores/tunnelProfileStore");

function sshProfile(id: string, host: string): TunnelProfile {
  return { ...createTunnelProfile("ssh"), id, name: id, host, user: "deploy" } as TunnelProfile;
}

type Store = ReturnType<typeof useTunnelProfileStore>;

/**
 * Faithful mirror of TunnelProfileManager.vue's draft state + seeding watcher.
 * `fixed: false` is the original (buggy) `!isDirty`-gated seed; `fixed: true`
 * is the shipped fix (seed on first load regardless of dirty).
 */
function mountManagerDraft(store: Store, fixed: boolean) {
  const draft = ref<TunnelProfile[]>([]);
  const selectedId = ref<string | null>(null);
  const initialized = ref(false);
  const isDirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(store.profiles));

  function resetDraft() {
    draft.value = clone(store.profiles);
    if (!draft.value.some((p) => p.id === selectedId.value)) selectedId.value = draft.value[0]?.id || null;
  }

  if (fixed) {
    watch(
      () => [store.isLoaded, store.profiles] as const,
      ([loaded]) => {
        if (!loaded) return;
        if (!initialized.value || !isDirty.value) {
          resetDraft();
          initialized.value = true;
        }
      },
      { immediate: true },
    );
  } else {
    watch(
      () => store.isLoaded,
      (loaded) => {
        if (loaded && !isDirty.value) resetDraft();
      },
      { immediate: true },
    );
  }

  return { draft, isDirty };
}

beforeEach(() => {
  disk.profiles = [];
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("tunnel profile persistence (data path behind issue #2)", () => {
  it("persists a saved profile and reloads it into a fresh store/session", async () => {
    const store = useTunnelProfileStore();
    await store.init();
    expect(store.profiles).toEqual([]);

    await store.saveProfiles([sshProfile("bastion", "bastion.example.com")]);
    expect(disk.profiles).toHaveLength(1);

    // A new session (fresh Pinia) — e.g. the ConnectionDialog opening later —
    // loads the same disk. The profile IS available to the dropdown.
    setActivePinia(createPinia());
    const dialogStore = useTunnelProfileStore();
    await dialogStore.init();
    expect(dialogStore.profiles.map((p) => p.id)).toEqual(["bastion"]);
    expect(dialogStore.profileById("bastion")?.host).toBe("bastion.example.com");
  });
});

describe("issue #1: Settings > Tunnels list after remount", () => {
  it("BUG: the original !isDirty-gated seed leaves the list empty on remount", async () => {
    const store = useTunnelProfileStore();
    await store.init();
    await store.saveProfiles([sshProfile("bastion", "bastion.example.com")]);

    // Remount the panel against the already-loaded store (switching settings
    // tabs recreates the component; draft starts empty).
    const { draft } = mountManagerDraft(store, /* fixed */ false);
    await nextTick();

    // Reproduces the report: saved profile exists in the store but the panel
    // renders nothing.
    expect(store.profiles).toHaveLength(1);
    expect(draft.value).toEqual([]);
  });

  it("FIX: seeding on first load shows the saved profile on remount", async () => {
    const store = useTunnelProfileStore();
    await store.init();
    await store.saveProfiles([sshProfile("bastion", "bastion.example.com")]);

    const { draft } = mountManagerDraft(store, /* fixed */ true);
    await nextTick();

    expect(draft.value.map((p) => p.id)).toEqual(["bastion"]);
  });
});

describe("issue #2 mechanism: stale-draft save wipes persisted profiles", () => {
  it("BUG: saving the empty buggy draft deletes the profile from disk", async () => {
    const store = useTunnelProfileStore();
    await store.init();
    await store.saveProfiles([sshProfile("bastion", "bastion.example.com")]);

    // Buggy remount → empty draft. The user, seeing an empty panel, hits Save.
    const { draft } = mountManagerDraft(store, /* fixed */ false);
    await nextTick();
    await store.saveProfiles(clone(draft.value)); // == saveProfiles([])

    // Disk is wiped → the ConnectionDialog dropdown now has nothing to offer.
    expect(disk.profiles).toEqual([]);
  });

  it("FIX: the seeded draft round-trips the save without data loss", async () => {
    const store = useTunnelProfileStore();
    await store.init();
    await store.saveProfiles([sshProfile("bastion", "bastion.example.com")]);

    const { draft } = mountManagerDraft(store, /* fixed */ true);
    await nextTick();
    await store.saveProfiles(clone(draft.value));

    expect(disk.profiles.map((p) => p.id)).toEqual(["bastion"]);
  });
});
