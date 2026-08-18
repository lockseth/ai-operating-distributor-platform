import type { ExecutiveContributor, ModuleKey, ModuleContribution } from "../types";

// =============================================================================
// Contributor placeholder untuk modul yang belum diimplementasikan.
// Saat modulnya dibangun (Phase 3+), ganti placeholder ini dengan contributor
// nyata — kontrak ModuleContribution sudah final, halaman eksekutif tidak
// perlu diubah.
// =============================================================================

function pendingContributor(module: ModuleKey, moduleLabel: string): ExecutiveContributor {
  return {
    module,
    moduleLabel,
    async contribute(): Promise<ModuleContribution> {
      return {
        module,
        moduleLabel,
        active: false,
        health: [],
        kpis: [],
        insights: [],
        actions: [],
      };
    },
  };
}

export const collectionContributor = pendingContributor("collection", "Collection");
export const whatsappContributor = pendingContributor("whatsapp", "WhatsApp AI");
export const warehouseContributor = pendingContributor("warehouse", "Warehouse");
