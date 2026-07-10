import { fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventProductsView } from './event-products-view';

type ProductsAdminApiMock = {
  listProductCategories: ReturnType<typeof vi.fn>;
  createProductCategory: ReturnType<typeof vi.fn>;
  listProducts: ReturnType<typeof vi.fn>;
  createProduct: ReturnType<typeof vi.fn>;
  updateProduct: ReturnType<typeof vi.fn>;
};

const adminApiMock = vi.hoisted(
  (): ProductsAdminApiMock => ({
    listProductCategories: vi.fn(),
    createProductCategory: vi.fn(),
    listProducts: vi.fn(),
    createProduct: vi.fn(),
    updateProduct: vi.fn(),
  }),
);

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    adminApi: adminApiMock,
  };
});

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ open, children }: { open?: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  SheetFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const category = {
  id: 'pcat_1',
  eventId: 'evt_1',
  name: 'Merch',
  sortOrder: 1,
};

const product = {
  id: 'prd_1',
  eventId: 'evt_1',
  name: 'Festival T-shirt',
  description: 'Soft cotton shirt',
  priceCents: 2500,
  currency: 'USD',
  categoryId: 'pcat_1',
  maxPerOrder: 2,
  status: 'active' as const,
  sortOrder: 1,
};

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function mockProductData() {
  adminApiMock.listProductCategories.mockResolvedValue({
    ok: true,
    data: [category],
  });
  adminApiMock.listProducts.mockResolvedValue({
    ok: true,
    data: [product],
  });
}

describe('EventProductsView', () => {
  it('renders products with their category and status', async () => {
    mockProductData();

    const view = render(<EventProductsView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getByText('Festival T-shirt')).toBeInTheDocument();
    });
    expect(view.getByText('Soft cotton shirt')).toBeInTheDocument();
    expect(view.getByText('Merch')).toBeInTheDocument();
    expect(view.getByText('$25.00')).toBeInTheDocument();
    expect(view.getByText('2 per order')).toBeInTheDocument();
  });

  it('shows a retryable product load error when categories load successfully', async () => {
    adminApiMock.listProductCategories.mockResolvedValue({
      ok: true,
      data: [category],
    });
    adminApiMock.listProducts.mockResolvedValue({
      ok: false,
      error: { code: 'products_unavailable', message: 'Products unavailable' },
    });

    const view = render(<EventProductsView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getByText('Failed to load products')).toBeInTheDocument();
    });
    expect(view.getByText('Products unavailable')).toBeInTheDocument();
    expect(view.queryByText('No products yet')).not.toBeInTheDocument();
    expect(view.getByText('Categories')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Try again' }));
    expect(adminApiMock.listProducts).toHaveBeenCalledTimes(2);
    expect(adminApiMock.listProductCategories).toHaveBeenCalledTimes(1);
  });

  it('keeps loaded products visible when categories fail to load', async () => {
    adminApiMock.listProductCategories.mockResolvedValue({
      ok: false,
      error: { code: 'categories_unavailable', message: 'Categories unavailable' },
    });
    adminApiMock.listProducts.mockResolvedValue({
      ok: true,
      data: [product],
    });

    const view = render(<EventProductsView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getByText('Festival T-shirt')).toBeInTheDocument();
    });
    expect(view.getByRole('alert')).toHaveTextContent('Failed to load product categories');
    expect(view.getByRole('alert')).toHaveTextContent('Categories unavailable');
    expect(view.getByText('Unknown category')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(adminApiMock.listProductCategories).toHaveBeenCalledTimes(2));
    expect(adminApiMock.listProducts).toHaveBeenCalledTimes(1);
  });

  it('creates categories through the admin API and refreshes category data', async () => {
    mockProductData();
    adminApiMock.createProductCategory.mockResolvedValue({
      ok: true,
      data: { ...category, id: 'pcat_2', name: 'Parking' },
    });

    const view = render(<EventProductsView eventId="evt_1" />);
    await waitFor(() => {
      expect(view.getByText('Festival T-shirt')).toBeInTheDocument();
    });

    fireEvent.click(view.getByRole('button', { name: 'Create category' }));
    fireEvent.change(view.getByLabelText('Name'), {
      target: { value: 'Parking' },
    });
    fireEvent.change(view.getByLabelText('Sort order'), {
      target: { value: '4' },
    });
    const categorySubmitButtons = view.getAllByRole('button', { name: 'Create category' });
    fireEvent.click(categorySubmitButtons[categorySubmitButtons.length - 1]);

    await waitFor(() => {
      expect(adminApiMock.createProductCategory).toHaveBeenCalledWith('evt_1', {
        name: 'Parking',
        sortOrder: 4,
      });
    });
    await waitFor(() => expect(adminApiMock.listProductCategories).toHaveBeenCalledTimes(2));
  });

  it('creates products with category, price, and order-limit payloads', async () => {
    mockProductData();
    adminApiMock.createProduct.mockResolvedValue({
      ok: true,
      data: { ...product, id: 'prd_2', name: 'Parking pass' },
    });

    const view = render(<EventProductsView eventId="evt_1" />);
    await waitFor(() => {
      expect(view.getByText('Festival T-shirt')).toBeInTheDocument();
    });

    fireEvent.click(view.getByRole('button', { name: 'Create product' }));
    fireEvent.change(view.getByLabelText('Name'), {
      target: { value: 'Parking pass' },
    });
    fireEvent.change(view.getByLabelText('Description'), {
      target: { value: 'Lot A parking' },
    });
    fireEvent.change(view.getByLabelText('Price'), {
      target: { value: '15.50' },
    });
    fireEvent.change(view.getByLabelText('Category'), {
      target: { value: 'pcat_1' },
    });
    fireEvent.change(view.getByLabelText('Max per order'), {
      target: { value: '1' },
    });
    const productSubmitButtons = view.getAllByRole('button', { name: 'Create product' });
    fireEvent.click(productSubmitButtons[productSubmitButtons.length - 1]);

    await waitFor(() => {
      expect(adminApiMock.createProduct).toHaveBeenCalledWith('evt_1', {
        name: 'Parking pass',
        description: 'Lot A parking',
        priceCents: 1550,
        currency: 'USD',
        categoryId: 'pcat_1',
        maxPerOrder: 1,
        status: 'active',
        availableFrom: undefined,
        availableUntil: undefined,
        sortOrder: undefined,
      });
    });
    await waitFor(() => expect(adminApiMock.listProducts).toHaveBeenCalledTimes(2));
  });
});
