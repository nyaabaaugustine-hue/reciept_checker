'use client';

import { Download, Printer, FileJson, FileSpreadsheet, Menu } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import type { ValidatedData } from '@/lib/types';
import { exportToCsv, exportToJson } from '@/lib/utils';

interface ExportMenuProps {
  data: ValidatedData;
}

export const ExportMenu = ({ data }: ExportMenuProps) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline"><Menu className="mr-2 h-4 w-4" /> Export</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => exportToJson(data)}>
          <FileJson className="mr-2 h-4 w-4" />
          <span>Export to JSON</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => exportToCsv(data)}>
          <FileSpreadsheet className="mr-2 h-4 w-4" />
          <span>Export to CSV</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => window.print()}>
          <Printer className="mr-2 h-4 w-4" />
          <span>Print</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
