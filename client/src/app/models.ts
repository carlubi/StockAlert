export type ProductStatus = 'pending' | 'active' | 'archived';

export interface Product {
  id: string;
  name: string;
  brand?: string | null;
  units: number | null;
  expiration_date: string | null;
  confidence: number;
  needs_review: boolean;
  status: ProductStatus;
  created_at: string;
}

export interface ExtractedProduct {
  name: string | null;
  brand?: string | null;
  units: number | null;
  expiration_date: string | null;
  confidence: number;
  date_label?: string | null;
  source_image_path?: string;
}

export interface AnalyzedProduct extends ExtractedProduct {
  id: string;
  status: ProductStatus;
  created_at: string;
  needs_review: boolean;
  missing_fields: string[];
}

export interface ProductInput {
  name: string;
  brand: string | null;
  units: number;
  expiration_date: string;
}
