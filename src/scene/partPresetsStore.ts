import { create } from 'zustand'
import type { Mesh, Vec2 } from './types'

/** A user-saved reusable part (e.g. a hand-modeled Torso/Limb topology), independent of any single
 *  project — persisted to localStorage so it's available from the "+ Add" → "My Parts" menu across
 *  every `.pptd` project, not just the one it was saved from. Deliberately kept out of the main
 *  scene store: it isn't scene data (not undo/redo-able, not saved into `.pptd`), it's a standing
 *  personal library the user builds up over time. */
export interface PartPreset {
  id: string
  name: string
  mesh: Mesh
  head: Vec2
  tail: Vec2
  color: string
}

const STORAGE_KEY = 'polypixel2d.partPresets'

function loadPresets(): PartPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function persist(presets: PartPreset[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets))
  } catch {
    // quota exceeded or localStorage unavailable — presets just won't survive a reload this time
  }
}

interface PartPresetsState {
  presets: PartPreset[]
  addPreset: (preset: Omit<PartPreset, 'id'>) => void
  removePreset: (id: string) => void
}

export const usePartPresetsStore = create<PartPresetsState>((set, get) => ({
  presets: loadPresets(),
  addPreset: (preset) => {
    const id = `preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const next = [...get().presets, { ...preset, id }]
    persist(next)
    set({ presets: next })
  },
  removePreset: (id) => {
    const next = get().presets.filter((p) => p.id !== id)
    persist(next)
    set({ presets: next })
  },
}))
