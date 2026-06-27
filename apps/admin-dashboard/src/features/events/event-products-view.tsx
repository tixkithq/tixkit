'use client'

import * as React from 'react'
import {
  Loader2,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Tags,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  adminApi,
  type AdminProduct,
  type AdminProductCategory,
  type CreateProductInput,
  type UpdateProductInput,
} from '@/lib/api'
import { useAdminData } from '@/hooks/use-admin-data'
import { formatCurrency, formatDateTime, formatNumber } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type ProductFormState = {
  name: string
  description: string
  price: string
  currency: string
  categoryId: string
  maxPerOrder: string
  status: AdminProduct['status']
  availableFrom: string
  availableUntil: string
  sortOrder: string
}

const noCategoryValue = '__none__'

const defaultProductFormState: ProductFormState = {
  name: '',
  description: '',
  price: '',
  currency: 'USD',
  categoryId: noCategoryValue,
  maxPerOrder: '10',
  status: 'active',
  availableFrom: '',
  availableUntil: '',
  sortOrder: '',
}

function productFormState(product?: AdminProduct): ProductFormState {
  if (!product) return defaultProductFormState
  return {
    name: product.name,
    description: product.description ?? '',
    price: centsToAmount(product.priceCents),
    currency: product.currency,
    categoryId: product.categoryId ?? noCategoryValue,
    maxPerOrder: String(product.maxPerOrder),
    status: product.status,
    availableFrom: isoToLocalInput(product.availableFrom),
    availableUntil: isoToLocalInput(product.availableUntil),
    sortOrder: String(product.sortOrder),
  }
}

function centsToAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}

function amountToCents(value: string): number | null {
  const normalized = value.trim()
  if (!normalized) return null
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.round(parsed * 100)
}

function positiveInteger(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < 1) return undefined
  return parsed
}

function optionalInteger(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < 0) return undefined
  return parsed
}

function localInputToIso(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

function isoToLocalInput(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 16)
}

function categoryLabel(
  product: AdminProduct,
  categories: AdminProductCategory[],
): string {
  if (!product.categoryId) return 'Uncategorized'
  return categories.find((category) => category.id === product.categoryId)?.name ?? 'Unknown category'
}

function buildCreateProductInput(values: ProductFormState): CreateProductInput | null {
  const priceCents = amountToCents(values.price)
  const maxPerOrder = positiveInteger(values.maxPerOrder)
  const sortOrder = optionalInteger(values.sortOrder)
  if (!values.name.trim() || priceCents === null || !maxPerOrder) return null
  return {
    name: values.name.trim(),
    description: values.description.trim() || undefined,
    priceCents,
    currency: values.currency.trim().toUpperCase() || 'USD',
    categoryId: values.categoryId === noCategoryValue ? undefined : values.categoryId,
    maxPerOrder,
    status: values.status,
    availableFrom: localInputToIso(values.availableFrom),
    availableUntil: localInputToIso(values.availableUntil),
    sortOrder,
  }
}

function buildUpdateProductInput(values: ProductFormState): UpdateProductInput | null {
  const createInput = buildCreateProductInput(values)
  if (!createInput) return null
  return {
    ...createInput,
    description: createInput.description ?? null,
    categoryId: createInput.categoryId ?? null,
    availableFrom: createInput.availableFrom ?? null,
    availableUntil: createInput.availableUntil ?? null,
  }
}

export function EventProductsView({ eventId }: { eventId: string }) {
  const {
    data: categories,
    loading: categoriesLoading,
    error: categoriesError,
    refetch: refetchCategories,
  } = useAdminData(() => adminApi.listProductCategories(eventId), [eventId])
  const {
    data: products,
    loading: productsLoading,
    error: productsError,
    refetch: refetchProducts,
  } = useAdminData(() => adminApi.listProducts(eventId), [eventId])
  const [categoryDialogOpen, setCategoryDialogOpen] = React.useState(false)
  const [productSheetOpen, setProductSheetOpen] = React.useState(false)
  const [editingProduct, setEditingProduct] = React.useState<AdminProduct | undefined>()

  const categoryList = categories ?? []
  const productList = products ?? []
  const loading = categoriesLoading || productsLoading
  const loadError = productsError ?? categoriesError
  const activeProducts = productList.filter((product) => product.status === 'active').length

  const openCreateProduct = () => {
    setEditingProduct(undefined)
    setProductSheetOpen(true)
  }

  const openEditProduct = (product: AdminProduct) => {
    setEditingProduct(product)
    setProductSheetOpen(true)
  }

  const refetchAll = () => {
    refetchCategories()
    refetchProducts()
  }

  if (loading) {
    return (
      <div className='space-y-3'>
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className='h-16 w-full' />
        ))}
      </div>
    )
  }

  if (loadError && productList.length === 0 && categoryList.length === 0) {
    return (
      <EmptyState
        icon={Package}
        title='Failed to load products'
        description={loadError.message}
        action={<Button onClick={refetchAll}>Try again</Button>}
      />
    )
  }

  return (
    <>
      <div className='grid gap-4 sm:grid-cols-3'>
        <Card>
          <CardContent className='p-4'>
            <p className='text-sm text-muted-foreground'>Products</p>
            <p className='text-2xl font-bold'>{formatNumber(productList.length)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className='p-4'>
            <p className='text-sm text-muted-foreground'>Active</p>
            <p className='text-2xl font-bold'>{formatNumber(activeProducts)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className='p-4'>
            <p className='text-sm text-muted-foreground'>Categories</p>
            <p className='text-2xl font-bold'>{formatNumber(categoryList.length)}</p>
          </CardContent>
        </Card>
      </div>

      <div className='flex flex-wrap justify-end gap-2'>
        <Button variant='outline' size='sm' onClick={() => setCategoryDialogOpen(true)}>
          <Tags className='size-4' />
          Create category
        </Button>
        <Button size='sm' onClick={openCreateProduct}>
          <Plus className='size-4' />
          Create product
        </Button>
      </div>

      {productList.length === 0 ? (
        <EmptyState
          icon={Package}
          title='No products yet'
          description='Create merch, add-ons, parking, or other products for this event.'
          action={
            <Button onClick={openCreateProduct}>
              <Plus className='size-4' />
              Create product
            </Button>
          }
        />
      ) : (
        <div className='rounded-md border'>
          <Table>
            <TableHeader>
              <TableRow className='hover:bg-transparent'>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Limit</TableHead>
                <TableHead>Availability</TableHead>
                <TableHead className='w-[50px]'>
                  <span className='sr-only'>Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {productList.map((product) => (
                <TableRow key={product.id}>
                  <TableCell>
                    <div className='font-medium'>{product.name}</div>
                    {product.description && (
                      <div className='text-sm text-muted-foreground'>{product.description}</div>
                    )}
                  </TableCell>
                  <TableCell>{categoryLabel(product, categoryList)}</TableCell>
                  <TableCell>{formatCurrency(product.priceCents, product.currency)}</TableCell>
                  <TableCell>
                    <Badge variant={product.status === 'active' ? 'default' : 'secondary'}>
                      {product.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatNumber(product.maxPerOrder)} per order</TableCell>
                  <TableCell className='text-sm text-muted-foreground'>
                    {product.availableFrom ? formatDateTime(product.availableFrom) : 'Now'}
                    {product.availableUntil ? ` - ${formatDateTime(product.availableUntil)}` : ''}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant='ghost' size='icon' className='size-8'>
                          <MoreHorizontal className='size-4' />
                          <span className='sr-only'>Open product actions</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align='end'>
                        <DropdownMenuLabel>Actions</DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => openEditProduct(product)}>
                          <Pencil className='size-4' />
                          Edit
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ProductCategoryDialog
        eventId={eventId}
        open={categoryDialogOpen}
        onOpenChange={setCategoryDialogOpen}
        onSuccess={refetchCategories}
      />
      <ProductSheet
        eventId={eventId}
        categories={categoryList}
        product={editingProduct}
        open={productSheetOpen}
        onOpenChange={setProductSheetOpen}
        onSuccess={refetchProducts}
      />
    </>
  )
}

function ProductCategoryDialog({
  eventId,
  open,
  onOpenChange,
  onSuccess,
}: {
  eventId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  const [name, setName] = React.useState('')
  const [sortOrder, setSortOrder] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setName('')
      setSortOrder('')
    }
  }, [open])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) {
      toast.error('Category name is required.')
      return
    }
    setSubmitting(true)
    const result = await adminApi.createProductCategory(eventId, {
      name: trimmedName,
      sortOrder: optionalInteger(sortOrder),
    })
    setSubmitting(false)
    if (!result.ok) {
      toast.error(result.error.message)
      return
    }
    toast.success('Product category created.')
    onOpenChange(false)
    onSuccess()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form className='space-y-4' onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Create product category</DialogTitle>
            <DialogDescription>
              Categories keep add-ons grouped for admins and buyers.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-2'>
            <Label htmlFor='product-category-name'>Name</Label>
            <Input
              id='product-category-name'
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='product-category-sort-order'>Sort order</Label>
            <Input
              id='product-category-sort-order'
              inputMode='numeric'
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={submitting}>
              {submitting && <Loader2 className='size-4 animate-spin' />}
              Create category
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ProductSheet({
  eventId,
  categories,
  product,
  open,
  onOpenChange,
  onSuccess,
}: {
  eventId: string
  categories: AdminProductCategory[]
  product?: AdminProduct
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  const [values, setValues] = React.useState<ProductFormState>(() => productFormState(product))
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (open) setValues(productFormState(product))
  }, [open, product])

  const setField = (field: keyof ProductFormState, value: string) => {
    setValues((current) => ({ ...current, [field]: value }))
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    const result = product
      ? await updateProduct(product.id, values)
      : await createProduct(eventId, values)
    setSubmitting(false)
    if (!result.ok) {
      toast.error(result.error.message)
      return
    }
    toast.success(product ? 'Product updated.' : 'Product created.')
    onOpenChange(false)
    onSuccess()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className='overflow-y-auto sm:max-w-xl'>
        <form className='flex min-h-full flex-col' onSubmit={submit}>
          <SheetHeader>
            <SheetTitle>{product ? 'Edit product' : 'Create product'}</SheetTitle>
            <SheetDescription>
              Products are add-ons such as merch, parking, donations, or upgrades.
            </SheetDescription>
          </SheetHeader>

          <div className='grid gap-4 px-4'>
            <div className='space-y-2'>
              <Label htmlFor='product-name'>Name</Label>
              <Input
                id='product-name'
                value={values.name}
                onChange={(event) => setField('name', event.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='product-description'>Description</Label>
              <Textarea
                id='product-description'
                value={values.description}
                onChange={(event) => setField('description', event.target.value)}
              />
            </div>
            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='space-y-2'>
                <Label htmlFor='product-price'>Price</Label>
                <Input
                  id='product-price'
                  inputMode='decimal'
                  placeholder='25.00'
                  value={values.price}
                  onChange={(event) => setField('price', event.target.value)}
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='product-currency'>Currency</Label>
                <Input
                  id='product-currency'
                  value={values.currency}
                  onChange={(event) => setField('currency', event.target.value)}
                />
              </div>
            </div>
            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='space-y-2'>
                <Label htmlFor='product-category'>Category</Label>
                <select
                  id='product-category'
                  className='h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
                  value={values.categoryId}
                  onChange={(event) => setField('categoryId', event.target.value)}
                >
                  <option value={noCategoryValue}>Uncategorized</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className='space-y-2'>
                <Label htmlFor='product-status'>Status</Label>
                <select
                  id='product-status'
                  className='h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
                  value={values.status}
                  onChange={(event) => setField('status', event.target.value)}
                >
                  <option value='active'>Active</option>
                  <option value='inactive'>Inactive</option>
                </select>
              </div>
            </div>
            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='space-y-2'>
                <Label htmlFor='product-max-per-order'>Max per order</Label>
                <Input
                  id='product-max-per-order'
                  inputMode='numeric'
                  value={values.maxPerOrder}
                  onChange={(event) => setField('maxPerOrder', event.target.value)}
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='product-sort-order'>Sort order</Label>
                <Input
                  id='product-sort-order'
                  inputMode='numeric'
                  value={values.sortOrder}
                  onChange={(event) => setField('sortOrder', event.target.value)}
                />
              </div>
            </div>
            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='space-y-2'>
                <Label htmlFor='product-available-from'>Available from</Label>
                <Input
                  id='product-available-from'
                  type='datetime-local'
                  value={values.availableFrom}
                  onChange={(event) => setField('availableFrom', event.target.value)}
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='product-available-until'>Available until</Label>
                <Input
                  id='product-available-until'
                  type='datetime-local'
                  value={values.availableUntil}
                  onChange={(event) => setField('availableUntil', event.target.value)}
                />
              </div>
            </div>
          </div>

          <SheetFooter>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={submitting}>
              {submitting && <Loader2 className='size-4 animate-spin' />}
              {product ? 'Save product' : 'Create product'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

async function createProduct(eventId: string, values: ProductFormState) {
  const payload = buildCreateProductInput(values)
  if (!payload) {
    return {
      ok: false as const,
      error: { code: 'VALIDATION_ERROR', message: 'Name, price, and a positive per-order limit are required.' },
    }
  }
  return adminApi.createProduct(eventId, payload)
}

async function updateProduct(productId: string, values: ProductFormState) {
  const payload = buildUpdateProductInput(values)
  if (!payload) {
    return {
      ok: false as const,
      error: { code: 'VALIDATION_ERROR', message: 'Name, price, and a positive per-order limit are required.' },
    }
  }
  return adminApi.updateProduct(productId, payload)
}
