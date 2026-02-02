export type CustomerCategoryOption = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  color?: string | null;
};

export type CustomerCategoryListEntry = CustomerCategoryOption & {
  createdAt: string;
  updatedAt: string;
  customerCount: number;
};

export type CustomerCategoryCreateInput = {
  name: string;
  description?: string;
  color?: string;
};

export type CustomerCategoryCreateResult = { success: true } | { success: false; error: string };
