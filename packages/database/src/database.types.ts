// =============================================================================
// FlowSales AI — Supabase Database Types
// Auto-generated shape can be replaced by: supabase gen types typescript
// =============================================================================

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      companies: {
        Row: {
          id: string;
          name: string;
          slug: string;
          domain: string | null;
          logo_url: string | null;
          settings: Json;
          subscription_plan: string;
          subscription_status: string;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          domain?: string | null;
          logo_url?: string | null;
          settings?: Json;
          subscription_plan?: string;
          subscription_status?: string;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          name: string;
          slug: string;
          domain: string | null;
          logo_url: string | null;
          settings: Json;
          subscription_plan: string;
          subscription_status: string;
          is_active: boolean;
          updated_at: string;
        }>;
      };
      users: {
        Row: {
          id: string;
          company_id: string;
          email: string;
          full_name: string;
          avatar_url: string | null;
          phone: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          company_id: string;
          email: string;
          full_name: string;
          avatar_url?: string | null;
          phone?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          full_name: string;
          avatar_url: string | null;
          phone: string | null;
          is_active: boolean;
          updated_at: string;
        }>;
      };
      roles: {
        Row: {
          id: string;
          company_id: string | null;
          name: string;
          description: string | null;
          is_system_role: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          company_id?: string | null;
          name: string;
          description?: string | null;
          is_system_role?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          name: string;
          description: string | null;
          updated_at: string;
        }>;
      };
      permissions: {
        Row: {
          id: string;
          name: string;
          module: string;
          action: string;
          description: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          module: string;
          action: string;
          description?: string | null;
        };
        Update: Partial<{
          description: string | null;
        }>;
      };
      user_roles: {
        Row: {
          id: string;
          user_id: string;
          role_id: string;
          company_id: string;
          assigned_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          role_id: string;
          company_id: string;
          assigned_by?: string | null;
          created_at?: string;
        };
        Update: never;
      };
      role_permissions: {
        Row: {
          role_id: string;
          permission_id: string;
        };
        Insert: {
          role_id: string;
          permission_id: string;
        };
        Update: never;
      };
      products: {
        Row: {
          id: string;
          company_id: string;
          sku: string;
          name: string;
          description: string | null;
          category_id: string | null;
          price: number;
          cost: number | null;
          unit: string;
          stock_quantity: number;
          min_stock: number;
          is_active: boolean;
          custom_fields: Json;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          company_id: string;
          sku: string;
          name: string;
          description?: string | null;
          category_id?: string | null;
          price: number;
          cost?: number | null;
          unit?: string;
          stock_quantity?: number;
          min_stock?: number;
          is_active?: boolean;
          custom_fields?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          sku: string;
          name: string;
          description: string | null;
          category_id: string | null;
          price: number;
          cost: number | null;
          unit: string;
          stock_quantity: number;
          min_stock: number;
          is_active: boolean;
          custom_fields: Json;
          updated_at: string;
        }>;
      };
      product_categories: {
        Row: {
          id: string;
          company_id: string;
          name: string;
          parent_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          company_id: string;
          name: string;
          parent_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          name: string;
          parent_id: string | null;
          updated_at: string;
        }>;
      };
      customers: {
        Row: {
          id: string;
          company_id: string;
          code: string;
          name: string;
          type: string;
          phone: string | null;
          email: string | null;
          address: string | null;
          area: string | null;
          assigned_sales_id: string | null;
          last_order_at: string | null;
          is_active: boolean;
          custom_fields: Json;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          company_id: string;
          code: string;
          name: string;
          type?: string;
          phone?: string | null;
          email?: string | null;
          address?: string | null;
          area?: string | null;
          assigned_sales_id?: string | null;
          last_order_at?: string | null;
          is_active?: boolean;
          custom_fields?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          code: string;
          name: string;
          type: string;
          phone: string | null;
          email: string | null;
          address: string | null;
          area: string | null;
          assigned_sales_id: string | null;
          last_order_at: string | null;
          is_active: boolean;
          custom_fields: Json;
          updated_at: string;
        }>;
      };
      sales_orders: {
        Row: {
          id: string;
          company_id: string;
          order_number: string;
          customer_id: string;
          sales_id: string | null;
          status: string;
          total_amount: number;
          discount_amount: number;
          tax_amount: number;
          final_amount: number;
          notes: string | null;
          delivery_date: string | null;
          delivered_at: string | null;
          custom_fields: Json;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          company_id: string;
          order_number?: string;
          customer_id: string;
          sales_id?: string | null;
          status?: string;
          total_amount?: number;
          discount_amount?: number;
          tax_amount?: number;
          final_amount?: number;
          notes?: string | null;
          delivery_date?: string | null;
          delivered_at?: string | null;
          custom_fields?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          customer_id: string;
          sales_id: string | null;
          status: string;
          total_amount: number;
          discount_amount: number;
          tax_amount: number;
          final_amount: number;
          notes: string | null;
          delivery_date: string | null;
          delivered_at: string | null;
          custom_fields: Json;
          updated_at: string;
        }>;
      };
      sales_order_items: {
        Row: {
          id: string;
          order_id: string;
          product_id: string;
          quantity: number;
          unit_price: number;
          discount_amount: number;
          total_amount: number;
          notes: string | null;
        };
        Insert: {
          id?: string;
          order_id: string;
          product_id: string;
          quantity: number;
          unit_price: number;
          discount_amount?: number;
          total_amount: number;
          notes?: string | null;
        };
        Update: Partial<{
          quantity: number;
          unit_price: number;
          discount_amount: number;
          total_amount: number;
          notes: string | null;
        }>;
      };
      audit_logs: {
        Row: {
          id: string;
          company_id: string;
          user_id: string | null;
          action: string;
          entity_type: string;
          entity_id: string | null;
          old_data: Json | null;
          new_data: Json | null;
          ip_address: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          company_id: string;
          user_id?: string | null;
          action: string;
          entity_type: string;
          entity_id?: string | null;
          old_data?: Json | null;
          new_data?: Json | null;
          ip_address?: string | null;
          user_agent?: string | null;
          created_at?: string;
        };
        Update: never;
      };
      settings: {
        Row: {
          id: string;
          company_id: string;
          key: string;
          value: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          company_id: string;
          key: string;
          value: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          value: Json;
          updated_at: string;
        }>;
      };
    };
    Views: Record<string, never>;
    Functions: {
      get_user_company_id: {
        Args: Record<string, never>;
        Returns: string;
      };
      get_user_roles: {
        Args: { p_user_id: string };
        Returns: string[];
      };
    };
    Enums: Record<string, never>;
  };
}
