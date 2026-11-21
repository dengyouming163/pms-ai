/**
 * CSV 报表导出工具
 * 纯前端实现，无需额外依赖
 */

interface ExportColumn {
  key: string;
  label: string;
  render?: (value: unknown, row: Record<string, unknown>) => string;
}

/**
 * 将数据导出为 CSV 文件并触发下载
 * 支持两种模式:
 * 1. 传入 columns 定义: exportToCSV(data, columns, filename)
 * 2. 自动从数据 key 生成: exportToCSV(data, filename) — key 作为列名
 */
export function exportToCSV(
  data: Record<string, unknown>[],
  columnsOrFilename: ExportColumn[] | string,
  filenameOrUndefined?: string
): void {
  let columns: ExportColumn[];
  let filename: string;
  
  if (Array.isArray(columnsOrFilename)) {
    columns = columnsOrFilename;
    filename = filenameOrUndefined || 'export';
  } else {
    filename = columnsOrFilename;
    // Auto-generate columns from data keys
    const keys = data.length > 0 ? Object.keys(data[0]) : [];
    columns = keys.map(k => ({ key: k, label: k }));
  }
  // BOM + CSV header
  const BOM = '\uFEFF';
  const header = columns.map(c => `"${c.label}"`).join(',');
  
  const rows = data.map(row => {
    return columns.map(col => {
      const value = row[col.key];
      const rendered = col.render ? col.render(value, row) : String(value ?? '');
      // Escape quotes and wrap in quotes
      return `"${rendered.replace(/"/g, '""')}"`;
    }).join(',');
  });

  const csv = BOM + header + '\n' + rows.join('\n');
  
  // Create blob and download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}_${formatDate(new Date())}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// ============ 预定义的导出配置 ============

/** 订单列表导出列 */
export const orderExportColumns: ExportColumn[] = [
  { key: 'id', label: '订单号' },
  { key: 'guestName', label: '客人姓名' },
  { key: 'roomTypeName', label: '房型' },
  { key: 'channelName', label: '渠道' },
  { key: 'checkIn', label: '入住日期' },
  { key: 'checkOut', label: '离店日期' },
  { key: 'amount', label: '金额' },
  { key: 'status', label: '状态', render: (v) => {
    const map: Record<string, string> = {
      confirmed: '已确认', checked_in: '已入住', checked_out: '已离店',
      cancelled: '已取消', pending_confirm: '待确认', no_show: '未到店'
    };
    return map[String(v)] || String(v);
  }},
  { key: 'paymentMethod', label: '支付方式', render: (v) => {
    const map: Record<string, string> = {
      wechat: '微信支付', alipay: '支付宝', cash: '现金', card: '银行卡', online: '在线支付'
    };
    return map[String(v)] || String(v);
  }},
  { key: 'createdAt', label: '创建时间' },
];

/** 收支流水导出列 */
export const transactionExportColumns: ExportColumn[] = [
  { key: 'id', label: '流水号' },
  { key: 'type', label: '类型', render: (v) => v === 'income' ? '收入' : '支出' },
  { key: 'category', label: '分类' },
  { key: 'amount', label: '金额' },
  { key: 'channelName', label: '渠道' },
  { key: 'orderId', label: '关联订单' },
  { key: 'description', label: '描述' },
  { key: 'transactionDate', label: '日期' },
];
