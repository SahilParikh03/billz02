import { BeamrApp } from "@/components/BeamrApp";
import { CdpProvider } from "@/components/cdp/CdpProvider";

export default function Home() {
  return (
    <CdpProvider>
      <BeamrApp />
    </CdpProvider>
  );
}
