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
  ["Customized for", appMetadata.customizedFor],
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
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          type="button"
          onClick={onClose}
        >
          Close
        </button>
      }
    >
      <dl className="divide-y divide-border text-sm">
        {ABOUT_ROWS.map(([label, value]) => (
          <div className="grid grid-cols-[120px_1fr] gap-4 py-3 first:pt-0 last:pb-0" key={label}>
            <dt className="font-medium text-foreground">{label}</dt>
            <dd className="min-w-0 text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </ModalDialog>
  );
}
