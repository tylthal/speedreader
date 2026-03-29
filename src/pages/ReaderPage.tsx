import { useParams, Link } from 'react-router-dom';
import ReaderViewport from '../components/ReaderViewport';

export default function ReaderPage() {
  const { pubId } = useParams<{ pubId: string }>();

  if (!pubId || isNaN(Number(pubId))) {
    return (
      <div className="reader-page__error">
        <span>Invalid publication ID</span>
        <Link to="/" className="reader-page__back">Back to Library</Link>
      </div>
    );
  }

  return <ReaderViewport publicationId={Number(pubId)} />;
}
