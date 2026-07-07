// =============================================================================
// Mock AI Provider
// Digunakan untuk development / demo tanpa API key.
// Mengembalikan response berupa template realistis berdasarkan prompt.
// =============================================================================

import type { AIProvider, CompletionRequest, CompletionResponse, EmbeddingRequest, EmbeddingResponse } from "../provider";

export class MockAIProvider implements AIProvider {
  readonly name = "openai" as const;

  isAvailable(): boolean {
    return true;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    await new Promise((r) => setTimeout(r, 50));

    const prompt = request.prompt.toLowerCase();
    let text = "";

    if (prompt.includes("churn") || prompt.includes("dormant")) {
      text = generateChurnText(request.prompt);
    } else if (prompt.includes("repeat order") || prompt.includes("next order")) {
      text = generateRepeatOrderText(request.prompt);
    } else if (prompt.includes("forecast") || prompt.includes("revenue")) {
      text = generateForecastText(request.prompt);
    } else if (prompt.includes("recommendation") || prompt.includes("sales")) {
      text = generateRecommendationText(request.prompt);
    } else if (prompt.includes("executive") || prompt.includes("summary")) {
      text = generateExecutiveSummaryText(request.prompt);
    } else {
      text = "Analisis sedang diproses. Silakan coba beberapa saat lagi.";
    }

    const tokenEstimate = Math.ceil(text.length / 4);
    return {
      text,
      usage: {
        promptTokens: Math.ceil(request.prompt.length / 4),
        completionTokens: tokenEstimate,
        totalTokens: Math.ceil(request.prompt.length / 4) + tokenEstimate,
      },
      model: "mock-v1",
      provider: "openai",
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const texts = Array.isArray(request.text) ? request.text : [request.text];
    const embeddings = texts.map(() =>
      Array.from({ length: 256 }, () => Math.random() * 2 - 1)
    );
    return {
      embeddings,
      usage: { totalTokens: texts.join(" ").length },
      model: "mock-embedding-v1",
      provider: "openai",
    };
  }
}

function generateChurnText(prompt: string): string {
  if (prompt.includes("HIGH")) {
    return "Reseller ini menunjukkan tanda-tanda churn yang kuat. Tidak ada aktivitas order dalam lebih dari 45 hari. Rekomendasikan kunjungan langsung oleh sales rep dalam 3 hari ke depan. Tawarkan program insentif atau diskon khusus untuk reaktivasi.";
  }
  if (prompt.includes("MEDIUM")) {
    return "Reseller mulai menunjukkan pola pengurangan frekuensi order. Kirim pesan follow-up personal dari sales rep dan tanyakan apakah ada kendala. Pertimbangkan penawaran produk baru yang relevan dengan histori pembelian mereka.";
  }
  return "Reseller masih dalam kategori aman, namun perlu dipantau. Pastikan sales rep melakukan check-in rutin setiap 2 minggu.";
}

function generateRepeatOrderText(prompt: string): string {
  return "Berdasarkan pola historis, reseller ini cenderung melakukan pembelaan ulang setiap 18-22 hari. Rekomendasi: hubungi 3 hari sebelum estimasi tanggal order berikutnya untuk konfirmasi kebutuhan dan memastikan stok tersedia.";
}

function generateForecastText(prompt: string): string {
  return "Proyeksi revenue didasarkan pada tren linear 6 bulan terakhir dengan mempertimbangkan seasonality. Faktor risiko: pola dormant customer yang meningkat di bulan 5-6. Rekomendasi: fokus pada aktivasi ulang 15 top dormant customer untuk menjaga momentum pertumbuhan.";
}

function generateRecommendationText(prompt: string): string {
  return "Prioritas hari ini: (1) Follow up 3 reseller yang mendekati tanggal estimasi order. (2) Kunjungi 2 reseller high-value yang belum order dalam 20 hari. (3) Konfirmasi pengiriman order yang sedang dalam status delivering. Fokus pada area dengan potensi konversi tertinggi.";
}

function generateExecutiveSummaryText(prompt: string): string {
  return "Performa bisnis bulan ini menunjukkan tren positif dengan peningkatan order dari area Jakarta. Perhatian utama: 30 reseller dalam kondisi dormant membutuhkan program reaktivasi segera. Peluang: repeat order rate 82% mengindikasikan loyalitas tinggi — momentum ini dapat dimanfaatkan untuk program referral. Rekomendasi strategis: alokasikan 40% kapasitas sales untuk follow-up reseller dormant bernilai tinggi minggu ini.";
}
