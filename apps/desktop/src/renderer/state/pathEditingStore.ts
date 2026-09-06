import { create } from 'zustand';
export const usePathEditingStore = create<{
    layerId: string | null;
    nodeId: string | null;
    setLayer: (id: string | null) => void;
    setNode: (id: string | null) => void;
}>(set => ({ layerId: null, nodeId: null, setLayer: layerId => set({ layerId, nodeId: null }), setNode: nodeId => set({ nodeId }) }));
