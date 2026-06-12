import { BeamrApp } from "@/components/BeamrApp";
import { AccountProvider } from "@/components/AccountProvider";

export default function Home() {
  return (
    <AccountProvider>
      <BeamrApp />
    </AccountProvider>
  );
}
