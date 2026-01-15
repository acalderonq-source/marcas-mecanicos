CREATE DATABASE IF NOT EXISTS control_mecanico CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE control_mecanico;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(100) NOT NULL,
  role ENUM('ADMIN', 'MECANICO') NOT NULL DEFAULT 'MECANICO'
);

CREATE TABLE IF NOT EXISTS attendance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  date DATE NOT NULL,
  check_in DATETIME NOT NULL,
  check_in_photo VARCHAR(255),
  check_out DATETIME DEFAULT NULL,
  check_out_photo VARCHAR(255),
  normal_hours DECIMAL(5,2) DEFAULT 0,
  extra_hours DECIMAL(5,2) DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  attendance_id INT,
  date DATE NOT NULL,
  plate VARCHAR(20) NOT NULL,
  job_type VARCHAR(50) NOT NULL,
  description TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (attendance_id) REFERENCES attendance(id)
);

-- Usuario admin por defecto
INSERT INTO users (name, username, password, role)
VALUES ('Administrador', 'admin', 'admin123', 'ADMIN')
ON DUPLICATE KEY UPDATE username = username;

-- Mecánico por defecto
INSERT INTO users (name, username, password, role)
VALUES ('Mecanico Remoto', 'mecanico', 'mecanico123', 'MECANICO')
ON DUPLICATE KEY UPDATE username = username;
