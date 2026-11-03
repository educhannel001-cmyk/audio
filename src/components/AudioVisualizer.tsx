import React from 'react';
import { motion } from 'motion/react';

interface Props {
  isPlaying: boolean;
  color?: string;
}

const AudioVisualizer: React.FC<Props> = ({ isPlaying, color = "#6366f1" }) => {
  return (
    <div className="flex items-center justify-center gap-0.5 h-full w-full">
      {[...Array(8)].map((_, i) => (
        <motion.div
          key={i}
          className="w-1 rounded-full"
          style={{ backgroundColor: color }}
          animate={isPlaying ? { height: [4, 16, 8, 20, 4] } : { height: 4 }}
          transition={{ repeat: Infinity, duration: 0.5 + i * 0.1, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
};

export default AudioVisualizer;
