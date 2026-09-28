export type ProductStatus = 'active' | 'archived';

export interface Product {
  id: string;
  name: string;
  brand?: string | null;
  expiration_date: string;
  confidence: number;
  status: ProductStatus;
  created_at: string;
}

export interface ExtractedProduct {
  name: string;
  brand?: string | null;
  expiration_date: string;
  confidence: number;
  date_label?: string | null;
  source_image_path?: string;
}
