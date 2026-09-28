export type ProductStatus = 'pending' | 'active' | 'archived';

export interface Product {
  id: string;
  name: string;
  brand?: string | null;
  units: number;
  expiration_date: string;
  confidence: number;
  status: ProductStatus;
  created_at: string;
}

export interface ExtractedProduct {
  name: string;
  brand?: string | null;
  units: number;
  expiration_date: string;
  confidence: number;
  date_label?: string | null;
  source_image_path?: string;
}

export interface AnalyzedProduct extends ExtractedProduct {
  id: string;
  status: 'pending';
  created_at: string;
}

export interface ProductInput {
  name: string;
  brand: string | null;
  units: number;
  expiration_date: string;
}
