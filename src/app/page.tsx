import { BillzApp } from "@/components/BillzApp";
import { CdpProvider } from "@/components/cdp/CdpProvider";

export default function Home() {
  return (
    <CdpProvider>
      <BillzApp />
    </CdpProvider>
  );
}
