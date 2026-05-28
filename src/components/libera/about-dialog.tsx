import { appMetadata } from "@/lib/app-metadata";
import { ModalDialog } from "@/components/libera/modal-dialog";

type AboutDialogProps = {
  open: boolean;
  onClose: () => void;
};

const ABOUT_ROWS = [
  ["App name", appMetadata.name],
  ["Version", appMetadata.version],
  ["Author", appMetadata.author],
  ["Release date", appMetadata.releaseDate],
] as const;

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  return (
    <ModalDialog
      open={open}
      title={`About ${appMetadata.name}`}
      description="Application information"
      onClose={onClose}
      footer={
        <button
          className="rounded-md bg-zinc-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
          type="button"
          onClick={onClose}
        >
          Close
        </button>
      }
    >
      <dl className="divide-y divide-zinc-200 text-sm">
        {ABOUT_ROWS.map(([label, value]) => (
          <div className="grid grid-cols-[120px_1fr] gap-4 py-3 first:pt-0 last:pb-0" key={label}>
            <dt className="font-medium text-zinc-600">{label}</dt>
            <dd className="min-w-0 text-zinc-950">{value}</dd>
          </div>
        ))}
      </dl>
    </ModalDialog>
  );
}
